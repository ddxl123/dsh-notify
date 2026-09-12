/**
 * Text shaping for outbound alerts: single-line subject folding, RFC 2047
 * encoded words, quoted-printable and base64 bodies, and the HTML rendering of
 * one notification. Kept free of Node APIs so it can be tested directly.
 *
 * @module dsh-notify-long/lib/core/text
 */

import { clip, sanitizeLine, sanitizeText } from '../util.js'

/** Maximum length of a mail subject before folding. */
export const SUBJECT_LIMIT = 180

/**
 * Whether `text` needs RFC 2047 encoding (any non-ASCII or control character).
 *
 * @param {string} text - candidate text
 * @returns {boolean} true when the text cannot travel as raw US-ASCII
 */
export function needsEncodedWord(text) {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (code < 32 || code > 126) return true
  }
  return false
}

/**
 * Encode one header value as RFC 2047 `B` encoded words, splitting long values
 * so no encoded word exceeds the 75-character limit.
 *
 * @param {string} text - the header value
 * @returns {string} either the original ASCII text or encoded words
 */
export function encodeHeaderWord(text) {
  const value = sanitizeLine(text)
  if (value === '' || !needsEncodedWord(value)) return value
  // Split on character boundaries first, then pack whole characters into
  // chunks of at most 45 bytes (60 base64 characters, inside the 75-char word
  // limit) so an encoded word can never split a UTF-8 sequence.
  const characters = [...value].map((character) => Buffer.from(character, 'utf8'))
  const chunkBytes = 45
  const words = []
  let chunk = []
  let size = 0
  for (const bytes of characters) {
    if (size + bytes.length > chunkBytes && chunk.length > 0) {
      words.push(`=?UTF-8?B?${Buffer.concat(chunk).toString('base64')}?=`)
      chunk = []
      size = 0
    }
    chunk.push(bytes)
    size += bytes.length
  }
  if (chunk.length > 0) words.push(`=?UTF-8?B?${Buffer.concat(chunk).toString('base64')}?=`)
  return words.join(' ')
}

/**
 * Encode a body with quoted-printable, soft-wrapping at 76 columns and keeping
 * multi-byte characters whole.
 *
 * @param {string} text - the body text
 * @returns {string} a quoted-printable encoded body
 */
export function encodeQuotedPrintable(text) {
  const source = Buffer.from(sanitizeText(text), 'utf8')
  const out = []
  let line = ''
  const pushLine = (soft) => {
    out.push(soft ? `${line}=` : line)
    line = ''
  }
  for (let index = 0; index < source.length; index += 1) {
    const byte = source[index]
    let token
    if (byte === 0x0a) {
      pushLine(false)
      continue
    }
    if (byte === 0x0d) continue
    if (byte === 0x09 || (byte >= 0x20 && byte <= 0x7e && byte !== 0x3d)) {
      token = String.fromCharCode(byte)
    } else {
      token = `=${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
    if (line.length + token.length > 75) pushLine(true)
    line += token
  }
  if (line.length > 0) out.push(line)
  return `${out.join('\r\n')}\r\n`
}

/**
 * Render the plain-text body of one alert.
 *
 * @param {object} input - rendering input
 * @param {string} input.kind - notification kind
 * @param {string} input.title - alert title
 * @param {string} input.body - alert body
 * @param {string} [input.sessionId] - owning session id
 * @param {string} [input.sessionTitle] - human session title
 * @param {string} [input.cwd] - session working directory
 * @param {number} [input.at] - epoch milliseconds the event was observed
 * @param {string} [input.urgency] - `info` | `action` | `error`
 * @param {string} [input.detail] - extra technical detail (error chain, etc.)
 * @param {string} [input.hint] - what the operator can do about it
 * @returns {string} the plain-text body
 */
export function renderTextBody(input) {
  const lines = []
  lines.push(input.title)
  lines.push('='.repeat(Math.min(60, Math.max(8, [...(input.title ?? '')].length))))
  lines.push('')
  if (input.body !== undefined && sanitizeText(input.body) !== '') {
    lines.push(sanitizeText(input.body))
    lines.push('')
  }
  if (input.detail !== undefined && sanitizeText(input.detail) !== '') {
    lines.push('Detail:')
    lines.push(sanitizeText(input.detail))
    lines.push('')
  }
  if (input.hint !== undefined && sanitizeText(input.hint) !== '') {
    lines.push(`Next: ${sanitizeText(input.hint)}`)
    lines.push('')
  }
  const facts = [
    ['Event', input.kind],
    ['Session', input.sessionTitle ?? input.sessionId],
    ['Session id', input.sessionId],
    ['Directory', input.cwd],
    ['Time', input.at === undefined ? undefined : new Date(input.at).toLocaleString()],
    ['Urgency', input.urgency],
  ].filter(([, value]) => typeof value === 'string' && value !== '')
  if (facts.length > 0) {
    lines.push('--')
    for (const [label, value] of facts) lines.push(`${label}: ${value}`)
  }
  lines.push('')
  lines.push('Sent by dsh-notify-long (DeepSeek Harness).')
  return `${lines.join('\n').trimEnd()}\n`
}

/** Escape the five XML-significant characters. @param {unknown} value - raw text @returns {string} escaped text */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Render the HTML alternative of one alert. Deliberately inline-styled and
 * table-free so it survives the most common mail clients.
 *
 * @param {object} input - the same rendering input as {@link renderTextBody}
 * @returns {string} an HTML document
 */
export function renderHtmlBody(input) {
  const accent = input.urgency === 'error' ? '#d93025' : input.urgency === 'action' ? '#1a73e8' : '#188038'
  const rows = [
    ['Event', input.kind],
    ['Session', input.sessionTitle ?? input.sessionId],
    ['Directory', input.cwd],
    ['Time', input.at === undefined ? undefined : new Date(input.at).toLocaleString()],
  ].filter(([, value]) => typeof value === 'string' && value !== '')
  const body = sanitizeText(input.body)
  const detail = sanitizeText(input.detail)
  const hint = sanitizeText(input.hint)
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"><title>',
    escapeHtml(input.title),
    '</title></head>',
    `<body style="margin:0;padding:16px;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#202124">`,
    `<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:10px;border:1px solid #e3e6ea;overflow:hidden">`,
    `<div style="height:4px;background:${accent}"></div>`,
    '<div style="padding:20px 22px">',
    `<div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${accent};font-weight:600">DeepSeek Harness · ${escapeHtml(input.kind)}</div>`,
    `<h1 style="margin:6px 0 12px;font-size:19px;line-height:1.35">${escapeHtml(input.title)}</h1>`,
    body === '' ? '' : `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;white-space:pre-wrap">${escapeHtml(body)}</p>`,
    detail === '' ? '' : `<pre style="margin:0 0 14px;padding:10px 12px;background:#f1f3f4;border-radius:6px;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word">${escapeHtml(detail)}</pre>`,
    hint === '' ? '' : `<p style="margin:0 0 14px;font-size:13px;line-height:1.6;color:#3c4043"><strong>Next:</strong> ${escapeHtml(hint)}</p>`,
    '<table style="border-collapse:collapse;font-size:12px;color:#5f6368">',
    ...rows.map(([label, value]) => `<tr><td style="padding:2px 10px 2px 0;white-space:nowrap">${escapeHtml(label)}</td><td style="padding:2px 0">${escapeHtml(value)}</td></tr>`),
    '</table>',
    '</div>',
    `<div style="padding:12px 22px;background:#fafbfc;border-top:1px solid #eceff1;font-size:11px;color:#80868b">Sent by dsh-notify-long · ${escapeHtml(input.at === undefined ? '' : new Date(input.at).toISOString())}</div>`,
    '</div></body></html>',
  ].filter((line) => line !== '').join('\n')
}

/**
 * Build the mail subject for an alert: `[DSH] <kind label> · <title>`, clipped
 * to a sane length.
 *
 * @param {object} input - subject input
 * @param {string} input.kind - notification kind
 * @param {string} input.title - alert title
 * @param {string} [input.prefix] - subject prefix, defaults to `[DSH]`
 * @returns {string} the raw (unencoded) subject
 */
export function buildSubject(input) {
  const prefix = sanitizeLine(input.prefix ?? '') || '[DSH]'
  const label = kindLabel(input.kind)
  const title = sanitizeLine(input.title)
  const composed = title === '' ? `${prefix} ${label}` : `${prefix} ${label} - ${title}`
  return clip(composed, SUBJECT_LIMIT)
}

/**
 * Short human label for one notification kind.
 *
 * @param {string} kind - notification kind
 * @returns {string} the label
 */
export function kindLabel(kind) {
  switch (kind) {
    case 'completed': return 'task finished'
    case 'question': return 'your input is needed'
    case 'approval': return 'approval needed'
    case 'error': return 'error'
    case 'subagent': return 'subagent finished'
    case 'test': return 'test alert'
    case 'manual': return 'notice'
    default: return kind
  }
}

/**
 * System-sound file suggestions per kind, so different outcomes sound different.
 *
 * @param {string} kind - notification kind
 * @returns {string[]} candidate sound names for the current platform
 */
export function soundsForKind(kind) {
  const mac = {
    completed: ['Glass', 'Hero'],
    question: ['Ping', 'Pop'],
    approval: ['Ping', 'Pop'],
    error: ['Basso', 'Sosumi'],
    subagent: ['Tink'],
    test: ['Pop'],
    manual: ['Pop'],
  }
  const chosen = mac[kind] ?? ['Pop']
  // The freedesktop sound theme ships the same event names on Linux.
  const freedesktop = {
    Glass: 'complete',
    Hero: 'complete',
    Ping: 'message',
    Pop: 'message-new-instant',
    Basso: 'dialog-error',
    Sosumi: 'dialog-warning',
    Tink: 'bell',
  }
  return [...chosen, ...chosen.map((name) => freedesktop[name]).filter(Boolean)]
}
