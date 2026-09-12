/**
 * Alert engine: decides, renders, enqueues and delivers notifications.
 *
 * The engine is intentionally harness-free. The Cordis plugin wires harness
 * events into {@link Engine.raise} and supplies the configuration; everything
 * else — routing, quiet hours, deduplication, channel calls, retry, and durable
 * queuing — lives here and is exercised directly by the test suite.
 *
 * @module dsh-notify/lib/core/engine
 */

import { describeError, clip, normalizeForHash, sanitizeText } from '../util.js'
import { dedupeKeyOf, Guard, quietHoursState, resolveRoute } from './policy.js'
import { makeRecord, Outbox } from './queue.js'

/** How long a squashed burst waits before its digest is sent. */
export const DIGEST_DELAY_MS = 60_000
/** How long a record stays in the outbox before it is abandoned. */
export const QUEUE_TTL_MS = 6 * 60 * 60 * 1000
/** Delivery attempts before a record is abandoned. */
export const MAX_ATTEMPTS = 5
/** Base backoff between attempts. */
export const RETRY_BASE_MS = 30_000
/** Hard cap on backoff. */
export const RETRY_MAX_MS = 15 * 60 * 1000

/**
 * @typedef {object} EngineOptions
 * @property {Outbox} outbox - durable alert queue
 * @property {Guard} guard - duplicate and cooldown guard
 * @property {() => any} settings - reads the effective configuration
 * @property {(input: any) => Promise<{ ok: boolean, detail: string }>} playSound - sound channel
 * @property {(input: any) => Promise<{ ok: boolean, detail: string }>} showDesktop - desktop channel
 * @property {(input: any) => Promise<{ ok: boolean, detail: string }>} sendEmail - email channel
 * @property {() => boolean} emailReady - whether SMTP can be attempted
 * @property {(message: string) => void} [log] - diagnostic sink
 * @property {() => number} [now] - clock injection for tests
 * @property {(ms: number) => Promise<void>} [sleep] - delay implementation, defaults to a timer
 */

/**
 * @typedef {object} DeliveryOutcome
 * @property {boolean} delivered - at least one channel succeeded
 * @property {string[]} channels - channels attempted
 * @property {string[]} failures - one line per failed channel
 */
export class Engine {
  /** @param {EngineOptions} options - engine dependencies */
  constructor(options) {
    this.outbox = options.outbox
    this.guard = options.guard
    this.settings = options.settings
    this.playSound = options.playSound
    this.showDesktop = options.showDesktop
    this.sendEmail = options.sendEmail
    this.emailReady = options.emailReady
    this.log = typeof options.log === 'function' ? options.log : () => {}
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.sleep = typeof options.sleep === 'function'
      ? options.sleep
      : (ms) => new Promise((resolve) => {
        const timer = setTimeout(resolve, ms)
        if (typeof timer.unref === 'function') timer.unref()
      })
    /** @type {Promise<void>} serializes drains so one record is never delivered twice concurrently */
    this.draining = Promise.resolve()
    /** @type {number} deliveries performed since start */
    this.delivered = 0
    /** @type {number} deliveries that failed at least once */
    this.failed = 0
    /** @type {string | undefined} last failure detail, for diagnostics */
    this.lastFailure = undefined
  }

  /** @returns {any} the current effective configuration */
  get config() {
    return this.settings() ?? {}
  }

  /**
   * Raise one notification: route it, quarantine duplicates, then either deliver
   * it now or persist it for later.
   *
   * @param {import('./policy.js').NotificationEvent} event - the notification
   * @returns {Promise<DeliveryOutcome & { skipped?: string, queued?: boolean }>} the outcome
   */
  async raise(event) {
    const settings = this.config
    const at = Number.isFinite(event.at) ? event.at : this.now()
    const notification = { ...event, at }
    const quiet = quietHoursState(settings?.quietHours?.start, settings?.quietHours?.end, new Date(at))
    const route = resolveRoute({ event: notification, settings, quiet, emailReady: this.emailReady() })
    if (!route.enabled) return { delivered: false, channels: [], failures: [], skipped: 'disabled by configuration' }

    const key = dedupeKeyOf(notification)
    if (this.guard.isDuplicate(key)) return { delivered: false, channels: [], failures: [], skipped: 'duplicate within the suppression window' }
    notification.dedupeKey = key

    // Sound collapses under bursts; a desktop banner and email are informative
    // per event, so they are only subject to the duplicate window above.
    let channels = route.channels
    if (channels.includes('sound') && this.guard.isChannelCoolingDown('sound')) {
      channels = channels.filter((channel) => channel !== 'sound')
    }
    const record = makeRecord(notification, { now: at })
    record.channels = channels
    this.outbox.add(record)
    await this.drain()
    return {
      delivered: record.delivered === true,
      channels,
      failures: record.failures ?? [],
      ...channels.length === 0 ? { skipped: 'collapsed into a recent alert' } : {},
      ...record.delivered !== true && channels.length > 0 ? { queued: true } : {},
    }
  }

  /**
   * Deliver one queued record over its assigned channels.
   *
   * @param {any} record - the outbox record
   * @returns {Promise<DeliveryOutcome>} the outcome
   */
  async deliver(record) {
    const settings = this.config
    const quiet = quietHoursState(settings?.quietHours?.start, settings?.quietHours?.end, new Date(record.at ?? this.now()))
    const channels = Array.isArray(record.channels) && record.channels.length > 0
      ? record.channels
      : ['sound', 'desktop', 'email']
    const failures = []
    const attempted = []
    let delivered = false
    const sessionTitle = record.sessionTitle
    for (const channel of channels) {
      if (channel === 'sound') {
        if (quiet.active) continue
        attempted.push('sound')
        const result = await this.playSound({
          file: this.soundFileFor(record),
          kind: record.kind,
          player: settings?.sound?.player,
          timeoutMs: settings?.sound?.timeoutMs,
        })
        if (result.ok) delivered = true
        else failures.push(`sound: ${result.detail}`)
        continue
      }
      if (channel === 'desktop') {
        if (quiet.active) continue
        attempted.push('desktop')
        const result = await this.showDesktop({
          title: this.desktopTitle(record),
          body: record.body === '' ? record.title : record.body,
          kind: record.kind,
          sound: settings?.desktop?.sound,
        })
        if (result.ok) delivered = true
        else failures.push(`desktop: ${result.detail}`)
        continue
      }
      if (channel === 'email') {
        attempted.push('email')
        const result = await this.sendEmail({ event: record, settings, sessionTitle })
        if (result.ok) delivered = true
        else failures.push(`email: ${result.detail}`)
      }
    }
    record.attempts = (record.attempts ?? 0) + 1
    record.delivered = delivered
    record.failures = failures
    record.channels = attempted
    return { delivered, channels: attempted, failures }
  }

  /**
   * Resolve the sound file for one record, preferring the per-kind default.
   *
   * @param {any} record - the outbox record
   * @returns {string | undefined} the configured file, when any
   */
  soundFileFor(record) {
    const settings = this.config
    const perKind = settings?.sound?.perKind ?? {}
    const configured = perKind[record.kind]
    if (typeof configured === 'string' && configured !== '') return configured
    const global = settings?.sound?.file
    return typeof global === 'string' && global !== '' ? global : undefined
  }

  /**
   * Compose the desktop banner title with the machine name so a multi-machine
   * operator can tell where the alert came from.
   *
   * @param {any} record - the outbox record
   * @returns {string} the banner title
   */
  desktopTitle(record) {
    const settings = this.config
    const prefix = settings?.desktop?.titlePrefix
    const base = typeof prefix === 'string' && prefix !== '' ? `${prefix} ${record.title}` : record.title
    return clip(base, 120)
  }

  /**
   * Deliver every due record, serialized behind one promise chain.
   *
   * @returns {Promise<{ delivered: number, failed: number, dropped: number }>} a drain summary
   */
  async drain() {
    const run = this.draining.then(() => this.#drainOnce())
    this.draining = run.then(() => undefined, () => undefined)
    return run
  }

  /** @returns {Promise<{ delivered: number, failed: number, dropped: number }>} one drain pass */
  async #drainOnce() {
    const summary = { delivered: 0, failed: 0, dropped: 0 }
    const due = this.outbox.due(this.now())
    for (const record of due) {
      if (this.now() - (record.at ?? 0) > QUEUE_TTL_MS) {
        this.outbox.remove(record.id)
        summary.dropped += 1
        this.log(`dsh-notify: dropped a stale ${record.kind} alert queued at ${new Date(record.at ?? 0).toISOString()}`)
        continue
      }
      let outcome
      try {
        outcome = await this.deliver(record)
      } catch (error) {
        outcome = { delivered: false, channels: record.channels ?? [], failures: [describeError(error)] }
      }
      if (outcome.delivered) {
        this.outbox.remove(record.id)
        this.delivered += 1
        summary.delivered += 1
        continue
      }
      this.failed += 1
      summary.failed += 1
      this.lastFailure = outcome.failures.join('; ')
      if ((record.attempts ?? 0) >= MAX_ATTEMPTS) {
        this.outbox.remove(record.id)
        summary.dropped += 1
        this.log(`dsh-notify: gave up on a ${record.kind} alert after ${record.attempts} attempts (${this.lastFailure})`)
        continue
      }
      record.notBefore = this.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, (record.attempts ?? 1) - 1))
      this.outbox.save()
      this.log(`dsh-notify: delivery of a ${record.kind} alert failed (${this.lastFailure}); retrying at ${new Date(record.notBefore).toISOString()}`)
    }
    return summary
  }

  /**
   * Raise the same alert for several records at once: one sound, one banner,
   * and one email listing everything. Used when a quiet or offline period ends.
   *
   * @param {any[]} records - records to squash
   * @returns {Promise<DeliveryOutcome>} the digest outcome
   */
  async digest(records) {
    const list = records.filter(Boolean)
    if (list.length === 0) return { delivered: false, channels: [], failures: [] }
    const lines = list.map((record) => `- [${record.kind}] ${record.title}${record.sessionTitle === undefined ? '' : ` (${record.sessionTitle})`}`)
    const event = {
      kind: 'manual',
      title: `${list.length} notifications while you were away`,
      body: lines.join('\n'),
      at: this.now(),
      urgency: 'info',
      hint: 'These were queued by dsh-notify because they could not be delivered when they happened.',
    }
    return this.raise(event)
  }

  /**
   * Report engine and channel status without revealing secrets.
   *
   * @returns {{ enabled: boolean, emailReady: boolean, queued: number, delivered: number, failed: number, lastFailure?: string, quiet: any }}
   *   a diagnostic snapshot
   */
  status() {
    const settings = this.config
    const quiet = quietHoursState(settings?.quietHours?.start, settings?.quietHours?.end)
    return {
      enabled: settings?.enabled !== false,
      emailReady: this.emailReady(),
      queued: this.outbox.size,
      delivered: this.delivered,
      failed: this.failed,
      ...this.lastFailure === undefined ? {} : { lastFailure: this.lastFailure },
      quiet,
    }
  }

  /**
   * Merge several pending records into one digest record, so a burst reaching
   * the outbox during a quiet period becomes a single message.
   *
   * @param {string} [reason] - why the digest is being built
   * @returns {number} how many records were merged away
   */
  squash(reason = 'burst') {
    const records = this.outbox.items.filter((entry) => entry.kind !== 'test')
    if (records.length < 2) return 0
    const digest = makeRecord({
      kind: 'manual',
      title: `${records.length} notifications (${reason})`,
      body: records.map((record) => `- [${record.kind}] ${record.title}`).join('\n'),
      at: this.now(),
      urgency: 'info',
    }, { now: this.now() })
    digest.channels = ['email']
    digest.digestOf = records.map((record) => record.id)
    for (const record of records) this.outbox.remove(record.id)
    this.outbox.add(digest)
    return records.length
  }
}

/**
 * Fingerprint a failure so repeated identical failures alert once per cooldown.
 *
 * @param {string} sessionId - owning session
 * @param {string} message - the failure message
 * @param {string} [stage] - failure stage
 * @returns {string} the fingerprint
 */
export function errorFingerprint(sessionId, message, stage = 'turn') {
  return `${stage}:${sessionId}:${normalizeForHash(sanitizeText(message))}`
}

/**
 * Count how many records the outbox currently holds for one session.
 *
 * @param {any} outbox - the outbox
 * @param {string} sessionId - owning session
 * @returns {number} the count
 */
export function pendingFor(outbox, sessionId) {
  return outbox.items.filter((record) => record.sessionId === sessionId).length
}
