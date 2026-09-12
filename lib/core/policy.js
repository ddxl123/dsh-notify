/**
 * Notification policy: quiet hours, duplicate suppression, error throttling,
 * and the per-kind channel routing table.
 *
 * Pure functions and one small stateful guard class, so the exact decisions the
 * engine makes can be unit-tested without a harness, a clock, or a network.
 *
 * @module dsh-notify-long/lib/core/policy
 */

import { clampInt, hashKey, normalizeForHash, parseClock } from '../util.js'

/** Notification kinds the engine can raise. */
export const KINDS = Object.freeze(['completed', 'question', 'approval', 'error', 'subagent', 'manual', 'test'])

/** Delivery channels a notification can travel over, in a stable order. */
export const CHANNELS = Object.freeze(['sound', 'desktop', 'email'])

/**
 * @typedef {object} QuietState
 * @property {boolean} active - whether the current local time is inside quiet hours
 * @property {boolean} configured - whether both bounds parse as `HH:MM`
 * @property {string[]} range - the configured `[start, end]` strings, when configured
 */

/**
 * Decide whether local time `date` falls inside the configured quiet-hours range.
 * A range that wraps midnight (`22:00` → `08:00`) is handled, as is the
 * degenerate equal-bounds range (treated as configured but never active).
 *
 * @param {string | undefined} start - quiet-hours start in `HH:MM`
 * @param {string | undefined} end - quiet-hours end in `HH:MM`
 * @param {Date} [date] - local time to test, defaults to now
 * @returns {QuietState} the quiet-hours evaluation
 */
export function quietHoursState(start, end, date = new Date()) {
  const from = parseClock(start)
  const to = parseClock(end)
  if (from === undefined || to === undefined) return { active: false, configured: false, range: [] }
  const minutes = date.getHours() * 60 + date.getMinutes()
  const active = from === to ? false : from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to
  return { active, configured: true, range: [start, end] }
}

/**
 * Format a quiet-hours window for display.
 *
 * @param {QuietState} state - the evaluation to describe
 * @returns {string} a human-readable window, or an empty string when unset
 */
export function describeQuietHours(state) {
  if (!state.configured) return ''
  return `${state.range[0]}–${state.range[1]}`
}

/**
 * @typedef {object} NotificationEvent
 * @property {'completed' | 'question' | 'approval' | 'error' | 'subagent' | 'manual' | 'test'} kind
 * @property {string} title - short alert title
 * @property {string} body - alert body
 * @property {string} [sessionId] - owning session, when the alert belongs to one
 * @property {number} [turn] - agent turn the alert belongs to
 * @property {string} [urgency] - `info` | `action` | `error`
 * @property {string} [fingerprint] - stable identity used for duplicate suppression
 * @property {string} [cwd] - session working directory
 * @property {number} [at] - epoch milliseconds the event was observed
 */

/**
 * Stable deduplication identity for one event. Two observations of the same
 * logical event (a status bounce, a replayed turn) must share this string.
 *
 * @param {NotificationEvent} event - the notification event
 * @returns {string} the dedupe key
 */
export function dedupeKeyOf(event) {
  const scope = event.sessionId ?? 'global'
  const stamp = event.turn === undefined ? '' : `#${event.turn}`
  const identity = event.fingerprint !== undefined && event.fingerprint !== ''
    ? hashKey(normalizeForHash(event.fingerprint))
    : hashKey(normalizeForHash(`${event.title}\n${event.body}`))
  return `${event.kind}:${scope}${stamp}:${identity}`
}

/**
 * Bounded, time-limited memory of what has already been delivered.
 *
 * Three guards live here because they share one lifetime:
 * - **duplicate window** — the same event must not alert twice within N seconds;
 * - **per-key cooldown** — a chatty error family alerts at most once per window;
 * - **channel cooldown** — sound/desktop bursts collapse into one alert.
 */
export class Guard {
  /**
   * @param {object} [options] - guard configuration
   * @param {number} [options.dedupeWindowMs] - duplicate suppression window per event
   * @param {number} [options.cooldownMs] - per-fingerprint cooldown for repeated failures
   * @param {number} [options.channelCooldownMs] - collapse window shared by audible channels
   * @param {number} [options.maxEntries] - retained keys per map
   * @param {() => number} [options.now] - clock injection for tests
   */
  constructor(options = {}) {
    this.dedupeWindowMs = clampInt(options.dedupeWindowMs, 300_000, 0, 86_400_000)
    this.cooldownMs = clampInt(options.cooldownMs, 600_000, 0, 86_400_000)
    this.channelCooldownMs = clampInt(options.channelCooldownMs, 15_000, 0, 3_600_000)
    this.maxEntries = clampInt(options.maxEntries, 500, 16, 10_000)
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    /** @type {Map<string, number>} */
    this.seen = new Map()
    /** @type {Map<string, number>} */
    this.cooldowns = new Map()
    /** @type {Map<string, number>} */
    this.channelLast = new Map()
  }

  /** @param {Map<string, number>} map - the map to prune @param {number} at - reference time */
  #prune(map, at) {
    const horizon = Math.max(this.dedupeWindowMs, this.cooldownMs, this.channelCooldownMs)
    if (map.size <= this.maxEntries) {
      for (const [key, stamp] of map) if (at - stamp > horizon) map.delete(key)
      return
    }
    const sorted = [...map.entries()].sort((left, right) => left[1] - right[1])
    for (const [key] of sorted.slice(0, sorted.length - this.maxEntries)) map.delete(key)
  }

  /**
   * Whether this event has already been handled inside the duplicate window.
   *
   * @param {string} key - dedupe identity from {@link dedupeKeyOf}
   * @returns {boolean} true when the caller should drop the event
   */
  isDuplicate(key) {
    const at = this.now()
    const stamp = this.seen.get(key)
    this.#prune(this.seen, at)
    if (stamp === undefined) {
      this.seen.set(key, at)
      return false
    }
    if (at - stamp > this.dedupeWindowMs) {
      this.seen.set(key, at)
      return false
    }
    return true
  }

  /**
   * Whether a repeated failure family is still inside its cooldown.
   *
   * @param {string} key - fingerprint of the failure
   * @returns {boolean} true when the caller should suppress the alert
   */
  isCoolingDown(key) {
    if (this.cooldownMs === 0) return false
    const at = this.now()
    const stamp = this.cooldowns.get(key)
    this.#prune(this.cooldowns, at)
    if (stamp !== undefined && at - stamp < this.cooldownMs) return true
    this.cooldowns.set(key, at)
    return false
  }

  /**
   * Whether an audible/desktop channel fired too recently to fire again.
   * Records the stamp when the channel may fire.
   *
   * @param {string} channel - channel name
   * @returns {boolean} true when the channel should stay silent this time
   */
  isChannelCoolingDown(channel) {
    if (this.channelCooldownMs === 0) return false
    const at = this.now()
    const stamp = this.channelLast.get(channel)
    if (stamp !== undefined && at - stamp < this.channelCooldownMs) return true
    this.channelLast.set(channel, at)
    return false
  }

  /** Drop every remembered key, e.g. after a configuration change. */
  reset() {
    this.seen.clear()
    this.cooldowns.clear()
    this.channelLast.clear()
  }
}

/**
 * @typedef {object} ChannelRoute
 * @property {boolean} enabled - whether this kind alerts at all
 * @property {string[]} channels - channels to deliver over
 */

/**
 * Resolve which channels one notification should use.
 *
 * Routing rules, in order:
 * 1. the kind is disabled → no channels;
 * 2. an explicit `channels` list on the kind overrides the global list;
 * 3. quiet hours remove the audible and desktop channels but keep email;
 * 4. an `error`-urgency notification always keeps email, so a hard failure is
 *    never silently swallowed;
 * 5. a channel requiring unconfigured SMTP drops out.
 *
 * @param {object} input - routing input
 * @param {NotificationEvent} input.event - the notification
 * @param {any} input.settings - effective configuration
 * @param {QuietState} input.quiet - current quiet-hours evaluation
 * @param {boolean} input.emailReady - whether SMTP is configured well enough to attempt delivery
 * @returns {ChannelRoute} the resolved route
 */
export function resolveRoute(input) {
  const { event, settings, quiet, emailReady } = input
  const kinds = settings?.alerts?.kinds ?? {}
  const policy = kinds[event.kind] ?? {}
  const enabled = policy.enabled !== false
  const configured = Array.isArray(policy.channels) && policy.channels.length > 0
    ? policy.channels
    : (Array.isArray(settings?.alerts?.channels) ? settings.alerts.channels : ['sound', 'desktop', 'email'])
  let channels = CHANNELS.filter((channel) => configured.includes(channel))
  if (!enabled) return { enabled: false, channels: [] }
  if (quiet.active) channels = channels.filter((channel) => channel === 'email')
  if (event.urgency === 'error' && !channels.includes('email') && emailReady) channels.push('email')
  if (!emailReady) channels = channels.filter((channel) => channel !== 'email')
  return { enabled: channels.length > 0, channels }
}
