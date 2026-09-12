/**
 * Small dependency-free helpers shared by every other module: clock parsing, a
 * defensive deep merge, byte/number formatting, and the header/secret hygiene
 * functions used before any string reaches a mail header or a child process.
 *
 * Nothing here imports the harness: these are plain Node helpers so they can be
 * unit-tested without a running DSH process.
 *
 * @module dsh-notify/lib/util
 */

/** @returns {number} wall-clock epoch milliseconds */
export function nowMs() {
  return Date.now()
}

/** @returns {boolean} whether `value` is a plain object (not an array, not null) */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Recursively overlay `override` on top of `base` without mutating either.
 * Arrays and scalars replace wholesale; `undefined` values never erase an
 * existing leaf. Used to fold the composition entry, the settings section, and
 * environment overrides into one effective configuration.
 *
 * @param {unknown} base - lower-precedence value
 * @param {unknown} override - higher-precedence value
 * @returns {any} the merged value
 */
export function deepMerge(base, override) {
  if (override === undefined) return clone(base)
  if (base === undefined) return clone(override)
  if (!isPlainObject(base) || !isPlainObject(override)) return clone(override)
  const result = clone(base)
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    result[key] = key in result ? deepMerge(result[key], value) : clone(value)
  }
  return result
}

/**
 * Deep-copy plain data (objects and arrays) and pass anything else through.
 * Deliberately shallow about class instances: this plugin never clones live
 * harness objects, only its own JSON-shaped configuration and queue records.
 *
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function clone(value) {
  if (Array.isArray(value)) return value.map((item) => clone(item))
  if (isPlainObject(value)) {
    const result = {}
    for (const [key, item] of Object.entries(value)) result[key] = clone(item)
    return result
  }
  return value
}

/**
 * Parse `HH:MM` (24-hour) into minutes since midnight.
 *
 * @param {unknown} value - candidate clock string
 * @returns {number | undefined} minutes since midnight, or undefined when unset/invalid
 */
export function parseClock(value) {
  if (typeof value !== 'string') return undefined
  const match = /^(\d{1,2}):(\d{2})$/.exec(sanitizeLine(value))
  if (match === null) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isInteger(hours) || hours < 0 || hours > 24) return undefined
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) return undefined
  if (hours === 24 && minutes !== 0) return undefined
  return hours * 60 + minutes
}

/** @param {number} minutes - minutes since midnight @returns {string} `HH:MM` */
export function formatClock(minutes) {
  const wrapped = ((Math.trunc(minutes) % 1440) + 1440) % 1440
  const hours = String(Math.floor(wrapped / 60)).padStart(2, '0')
  const mins = String(wrapped % 60).padStart(2, '0')
  return `${hours}:${mins}`
}

/**
 * Strip CR/LF and other control characters from a single-line string. Applied
 * to every value that could reach a mail header or a command argument, so a
 * model-authored message can never inject a header or a second argument.
 *
 * @param {unknown} value - candidate text
 * @returns {string} one line of printable text
 */
export function sanitizeLine(value) {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Normalize a multi-line message: uniform newlines, no trailing blank lines,
 * and no run of more than two blank lines.
 *
 * @param {unknown} value - candidate text
 * @returns {string} normalized text
 */
export function sanitizeText(value) {
  if (typeof value !== 'string') return ''
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Cut `text` to at most `max` characters, appending an ellipsis marker when
 * content was dropped.
 *
 * @param {unknown} text - candidate text
 * @param {number} max - maximum characters to keep (must be > 0)
 * @returns {string} the capped text
 */
export function clip(text, max) {
  const value = typeof text === 'string' ? text : ''
  if (!Number.isFinite(max) || max <= 0) return ''
  const limit = Math.trunc(max)
  if (value.length <= limit) return value
  return `${value.slice(0, limit - 1)}…`
}

/**
 * Mask a secret for logs and diagnostics: keep a short prefix only, never the
 * full value.
 *
 * @param {unknown} secret - the secret
 * @returns {string} a display form that reveals at most two characters
 */
export function redact(secret) {
  if (typeof secret !== 'string' || secret.length === 0) return ''
  const prefix = secret.slice(0, Math.min(2, secret.length))
  return `${prefix}${'*'.repeat(Math.min(8, Math.max(3, secret.length - prefix.length)))}`
}

/**
 * Collapse whitespace and lowercase, for fingerprints and duplicate detection.
 *
 * @param {unknown} text - candidate text
 * @returns {string} the normalized fingerprint seed
 */
export function normalizeForHash(text) {
  if (typeof text !== 'string') return ''
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Deterministic 32-bit FNV-1a hash rendered as hex. Only used for in-process
 * deduplication keys, never for anything security-related.
 *
 * @param {unknown} text - candidate text
 * @returns {string} eight hex characters
 */
export function hashKey(text) {
  const seed = typeof text === 'string' ? text : ''
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Coerce a positive finite number, falling back when the value is unusable.
 *
 * @param {unknown} value - candidate number
 * @param {number} fallback - value used when `value` is not a positive finite number
 * @returns {number} a usable number
 */
export function positiveNumber(value, fallback) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback
  return numeric
}

/**
 * Coerce an integer inside an inclusive range.
 *
 * @param {unknown} value - candidate number
 * @param {number} fallback - value used when the candidate is unusable
 * @param {number} min - inclusive lower bound
 * @param {number} max - inclusive upper bound
 * @returns {number} an integer inside the range
 */
export function clampInt(value, fallback, min, max) {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(numeric)))
}

/**
 * Describe an unknown thrown value without assuming it is an Error.
 *
 * @param {unknown} error - the thrown value
 * @returns {string} a printable one-line description
 */
export function describeError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}
