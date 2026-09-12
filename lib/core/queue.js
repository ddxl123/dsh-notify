/**
 * Durable alert outbox.
 *
 * A notification is appended to a single JSON document before any channel is
 * contacted, so a crash, a reload, or a quit mid-delivery cannot lose the fact
 * that the operator has to be told something. Delivery attempts update the
 * record and remove it once every channel either succeeded or gave up.
 *
 * @module dsh-notify-long/lib/core/queue
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { clampInt, describeError, isPlainObject } from '../util.js'

/** Maximum records retained in the outbox. */
export const MAX_QUEUE_ENTRIES = 200
/** Records older than this are dropped on load: an alert nobody saw for a day is noise. */
export const MAX_QUEUE_AGE_MS = 24 * 60 * 60 * 1000

/**
 * @typedef {object} AlertRecord
 * @property {string} id - unique record id
 * @property {number} at - epoch milliseconds the event happened
 * @property {string} kind - notification kind
 * @property {string} title - alert title
 * @property {string} body - alert body
 * @property {string} [detail] - extra technical detail
 * @property {string} [hint] - suggested next step
 * @property {string} [sessionId] - owning session
 * @property {string} [sessionTitle] - human session title
 * @property {string} [cwd] - session working directory
 * @property {string} [urgency] - `info` | `action` | `error`
 * @property {number} [turn] - agent turn
 * @property {string} [dedupeKey] - dedupe identity, retained for diagnostics
 * @property {number} attempts - delivery attempts already made
 * @property {number} [notBefore] - epoch milliseconds before which no attempt should be made
 * @property {boolean} [transientOnly] - record was created while every channel was unavailable
 */

/** @returns {string} a short unique id */
function newId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Build one outbox record from a notification event.
 *
 * @param {import('./policy.js').NotificationEvent} event - the notification
 * @param {object} [extra] - additional record fields
 * @returns {AlertRecord} the record
 */
export function makeRecord(event, extra = {}) {
  return {
    id: newId(),
    at: Number.isFinite(event.at) ? event.at : (Number.isFinite(extra.now) ? extra.now : Date.now()),
    kind: event.kind,
    title: event.title,
    body: event.body ?? '',
    ...event.detail === undefined ? {} : { detail: event.detail },
    ...event.hint === undefined ? {} : { hint: event.hint },
    ...event.sessionId === undefined ? {} : { sessionId: event.sessionId },
    ...event.sessionTitle === undefined ? {} : { sessionTitle: event.sessionTitle },
    ...event.cwd === undefined ? {} : { cwd: event.cwd },
    ...event.urgency === undefined ? {} : { urgency: event.urgency },
    ...event.turn === undefined ? {} : { turn: event.turn },
    ...event.dedupeKey === undefined ? {} : { dedupeKey: event.dedupeKey },
    attempts: 0,
    ...extra,
  }
}

/**
 * Normalize one persisted record, dropping anything unusable.
 *
 * @param {unknown} value - candidate record
 * @returns {AlertRecord | undefined} the normalized record, or undefined when it cannot be used
 */
export function normalizeRecord(value) {
  if (!isPlainObject(value)) return undefined
  if (typeof value.id !== 'string' || value.id === '') return undefined
  if (typeof value.kind !== 'string' || typeof value.title !== 'string') return undefined
  return {
    id: value.id,
    at: Number.isFinite(value.at) ? value.at : Date.now(),
    kind: value.kind,
    title: value.title,
    body: typeof value.body === 'string' ? value.body : '',
    ...typeof value.detail === 'string' ? { detail: value.detail } : {},
    ...typeof value.hint === 'string' ? { hint: value.hint } : {},
    ...typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {},
    ...typeof value.sessionTitle === 'string' ? { sessionTitle: value.sessionTitle } : {},
    ...typeof value.cwd === 'string' ? { cwd: value.cwd } : {},
    ...typeof value.urgency === 'string' ? { urgency: value.urgency } : {},
    ...Number.isFinite(value.turn) ? { turn: value.turn } : {},
    ...typeof value.dedupeKey === 'string' ? { dedupeKey: value.dedupeKey } : {},
    attempts: clampInt(value.attempts, 0, 0, 1000),
    ...Number.isFinite(value.notBefore) ? { notBefore: value.notBefore } : {},
    ...value.transientOnly === true ? { transientOnly: true } : {},
  }
}

/**
 * File-backed outbox. Every mutation is persisted immediately, and the write is
 * atomic (`<file>.tmp` → rename) so a crash mid-write cannot truncate the queue.
 */
export class Outbox {
  /**
   * @param {object} options - outbox options
   * @param {string} options.path - absolute path of the JSON document
   * @param {(message: string) => void} [options.onError] - diagnostic sink
   * @param {() => number} [options.now] - clock injection for tests
   */
  constructor(options) {
    this.path = options.path
    this.onError = typeof options.onError === 'function' ? options.onError : () => {}
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    /** @type {AlertRecord[]} */
    this.items = []
    /** @type {number} */
    this.dropped = 0
  }

  /**
   * Read the queue from disk, dropping stale or malformed records.
   *
   * @returns {{ loaded: number, dropped: number }} what the load found
   */
  load() {
    let raw
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch {
      return { loaded: 0, dropped: 0 }
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      this.onError(`dsh-notify-long: outbox at ${this.path} is not valid JSON and was reset (${describeError(error)})`)
      this.items = []
      return { loaded: 0, dropped: 0 }
    }
    const list = isPlainObject(parsed) && Array.isArray(parsed.items) ? parsed.items : []
    const horizon = this.now() - MAX_QUEUE_AGE_MS
    const kept = []
    let dropped = 0
    for (const entry of list) {
      const record = normalizeRecord(entry)
      if (record === undefined || record.at < horizon) {
        dropped += 1
        continue
      }
      kept.push(record)
    }
    this.items = kept.slice(-MAX_QUEUE_ENTRIES)
    this.dropped += dropped
    return { loaded: this.items.length, dropped }
  }

  /** Persist the queue. Failures are reported, never thrown. */
  save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const temp = `${this.path}.tmp`
      writeFileSync(temp, `${JSON.stringify({ version: 1, savedAt: this.now(), items: this.items }, undefined, 2)}\n`, 'utf8')
      renameSync(temp, this.path)
    } catch (error) {
      this.onError(`dsh-notify-long: could not persist the outbox at ${this.path} (${describeError(error)})`)
    }
  }

  /**
   * Append one record.
   *
   * @param {AlertRecord} record - the record to enqueue
   * @returns {AlertRecord} the stored record
   */
  add(record) {
    this.items.push(record)
    if (this.items.length > MAX_QUEUE_ENTRIES) this.items = this.items.slice(-MAX_QUEUE_ENTRIES)
    this.save()
    return record
  }

  /**
   * Remove one record by id.
   *
   * @param {string} id - the record id
   * @returns {boolean} true when a record was removed
   */
  remove(id) {
    const before = this.items.length
    this.items = this.items.filter((entry) => entry.id !== id)
    const removed = this.items.length !== before
    if (removed) this.save()
    return removed
  }

  /**
   * Records whose next attempt is due.
   *
   * @param {number} [at] - reference time, defaults to now
   * @returns {AlertRecord[]} due records, oldest first
   */
  due(at = this.now()) {
    return this.items.filter((entry) => entry.notBefore === undefined || entry.notBefore <= at)
  }

  /** @returns {number} number of pending records */
  get size() {
    return this.items.length
  }

  /** Drop every record, persisting the empty queue. @returns {number} how many records were dropped */
  clear() {
    const count = this.items.length
    this.items = []
    this.save()
    return count
  }

  /**
   * Reset every record's attempt budget so a later drain retries them.
   *
   * @returns {number} how many records were reset
   */
  retryAll() {
    for (const entry of this.items) {
      entry.attempts = 0
      delete entry.notBefore
    }
    this.save()
    return this.items.length
  }
}
