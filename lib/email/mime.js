/**
 * RFC 5322 message construction for the email channel: header encoding, an
 * optional HTML alternative, and MIME framing.
 *
 * @module dsh-notify/lib/email/mime
 */

import { sanitizeLine } from '../util.js'
import {
  buildSubject,
  encodeHeaderWord,
  encodeQuotedPrintable,
  renderHtmlBody,
  renderTextBody,
} from '../core/text.js'

/** Default sender display name. */
export const DEFAULT_FROM_NAME = 'DeepSeek Harness'

/**
 * Validate and normalize one mail address, optionally with a display name.
 * Rejects anything carrying CR/LF so a stored address can never inject a
 * header; accepts both `local@domain` and `Display Name <local@domain>`.
 *
 * @param {unknown} value - candidate address
 * @returns {string | undefined} the normalized address, or undefined when unusable
 */
export function normalizeAddress(value) {
  const raw = String(value ?? '').replace(/[\r\n]+/g, ' ').trim()
  if (raw === '') return undefined
  const angled = /^(.*?)<([^<>]+)>$/.exec(raw)
  const display = angled === null ? '' : sanitizeLine(angled[1])
  const address = sanitizeLine(angled === null ? raw : angled[2])
  if (!isMailAddress(address)) return undefined
  if (display === '') return address
  return `${encodeHeaderWord(display)} <${address}>`
}

/**
 * Whether `value` looks like a bare `local@domain` address.
 *
 * @param {string} value - candidate address
 * @returns {boolean} true when the address shape is plausible
 */
export function isMailAddress(value) {
  return /^[^\s@,;:<>()[\]\\]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value)
}

/**
 * Split a configured recipient list on commas/semicolons and normalize entries.
 *
 * @param {unknown} value - configured recipients (string or array)
 * @returns {string[]} normalized addresses, in order, without duplicates
 */
export function normalizeRecipients(value) {
  const parts = Array.isArray(value) ? value : String(value ?? '').split(/[,;]/)
  const out = []
  for (const part of parts) {
    const address = normalizeAddress(part)
    if (address === undefined) continue
    if (!out.includes(address)) out.push(address)
  }
  return out
}

/**
 * Build one complete MIME message.
 *
 * @param {object} input - message input
 * @param {string} input.from - normalized sender
 * @param {string[]} input.to - normalized recipients
 * @param {string} [input.cc] - normalized carbon-copy recipients
 * @param {string} input.subject - raw (unencoded) subject
 * @param {string} input.text - plain-text body
 * @param {string} [input.html] - HTML alternative body
 * @param {number} [input.at] - epoch milliseconds used for the Date header
 * @param {string} [input.kind] - notification kind, exported as `X-DSH-Kind`
 * @param {string} [input.prefix] - subject prefix
 * @returns {{ raw: string, subject: string, messageId: string }} the framed message
 */
export function buildMessage(input) {
  const at = input.at ?? Date.now()
  const subject = buildSubject({ kind: input.kind ?? 'manual', title: input.subject, prefix: input.prefix })
  const messageId = `<${at}.${Math.random().toString(36).slice(2, 10)}@${domainOf(input.from)}>`
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to.join(', ')}`,
    input.cc !== undefined && input.cc.length > 0 ? `Cc: ${input.cc.join(', ')}` : '',
    `Subject: ${encodeHeaderWord(subject)}`,
    `Date: ${new Date(at).toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
    `X-DSH-Kind: ${sanitizeLine(input.kind ?? 'manual')}`,
    'X-Mailer: dsh-notify',
  ].filter((line) => line !== '')

  const html = input.html === undefined ? undefined : String(input.html)
  let body
  if (html === undefined || html.trim() === '') {
    body = [
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      encodeQuotedPrintable(input.text),
    ].join('\r\n')
  } else {
    const boundary = `dsh-notify-${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    body = [
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      encodeQuotedPrintable(input.text),
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(Buffer.from(html, 'utf8').toString('base64')),
      `--${boundary}--`,
      '',
    ].join('\r\n')
  }
  return { raw: `${headers.join('\r\n')}\r\n${body}`, subject, messageId }
}

/**
 * Assemble a ready-to-send alert message from one notification record.
 *
 * @param {object} input - assembly input
 * @param {object} input.event - the notification event
 * @param {any} input.settings - effective configuration
 * @param {string} [input.sessionTitle] - human title of the owning session
 * @returns {{ raw: string, subject: string, messageId: string, from: string, to: string[], cc: string[] } | undefined}
 *   the message, or undefined when the email configuration is unusable
 */
export function buildAlertMessage(input) {
  const email = input.settings?.email ?? {}
  const from = normalizeAddress(email.from)
  const to = normalizeRecipients(email.to)
  if (from === undefined || to.length === 0) return undefined
  const cc = normalizeRecipients(email.cc)
  const rendered = {
    kind: input.event.kind,
    title: input.event.title,
    body: input.event.body,
    detail: input.event.detail,
    hint: input.event.hint,
    sessionId: input.event.sessionId,
    sessionTitle: input.sessionTitle,
    cwd: input.event.cwd,
    at: input.event.at,
    urgency: input.event.urgency,
  }
  const message = buildMessage({
    from,
    to,
    cc,
    subject: input.event.title,
    text: renderTextBody(rendered),
    html: email.html === false ? undefined : renderHtmlBody(rendered),
    at: input.event.at,
    kind: input.event.kind,
    prefix: email.subjectPrefix,
  })
  return { ...message, from, to, cc }
}

/** @param {string} from - normalized sender @returns {string} the domain part used in Message-ID */
function domainOf(from) {
  const match = /@([^\s>]+)/.exec(from)
  return match?.[1] ?? 'dsh.local'
}

/** @param {string} base64 - base64 text @returns {string} 76-column wrapped base64 */
function wrapBase64(base64) {
  const lines = []
  for (let offset = 0; offset < base64.length; offset += 76) lines.push(base64.slice(offset, offset + 76))
  return lines.join('\r\n')
}
