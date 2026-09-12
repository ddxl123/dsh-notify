/**
 * Email channel: turns a notification into a message and submits it over SMTP.
 *
 * Credential resolution is layered so a password never has to be written into a
 * tracked file:
 *
 * 1. `email.passEnv` names an environment variable (default `DSH_SMTP_PASSWORD`);
 * 2. `email.pass` is a literal in the composition or settings document;
 * 3. `email.passCommand` is a local command whose stdout is the secret
 *    (Keychain helper, `security find-generic-password`, `pass`, …).
 *
 * @module dsh-notify/lib/channels/email
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { describeError, deepMerge, positiveNumber, sanitizeLine } from '../util.js'
import { buildAlertMessage, normalizeAddress, normalizeRecipients } from '../email/mime.js'
import { sendMail } from '../email/smtp.js'

const run = promisify(execFile)

/**
 * Well-known provider endpoints, so a configuration only needs a user, a sender
 * and a recipient. `implicit` means TLS from the first byte (port 465);
 * `starttls` upgrades a plain connection (port 587).
 */
export const PROVIDER_PRESETS = Object.freeze({
  qq: { host: 'smtp.qq.com', port: 465, tls: 'implicit' },
  'qq-exmail': { host: 'smtp.exmail.qq.com', port: 465, tls: 'implicit' },
  '163': { host: 'smtp.163.com', port: 465, tls: 'implicit' },
  '163-enterprise': { host: 'smtphz.qiye.163.com', port: 465, tls: 'implicit' },
  aliyun: { host: 'smtp.qiye.aliyun.com', port: 465, tls: 'implicit' },
  gmail: { host: 'smtp.gmail.com', port: 465, tls: 'implicit' },
  outlook: { host: 'smtp-mail.outlook.com', port: 587, tls: 'starttls' },
  office365: { host: 'smtp.office365.com', port: 587, tls: 'starttls' },
  icloud: { host: 'smtp.mail.me.com', port: 587, tls: 'starttls' },
  zoho: { host: 'smtp.zoho.com', port: 465, tls: 'implicit' },
  yahoo: { host: 'smtp.mail.yahoo.com', port: 465, tls: 'implicit' },
  sendgrid: { host: 'smtp.sendgrid.net', port: 587, tls: 'starttls', user: 'apikey' },
  mailgun: { host: 'smtp.mailgun.org', port: 587, tls: 'starttls' },
  resend: { host: 'smtp.resend.com', port: 465, tls: 'implicit', user: 'resend' },
  brevo: { host: 'smtp-relay.brevo.com', port: 587, tls: 'starttls' },
})

/**
 * Resolve the effective email section: a named provider preset supplies
 * host/port/transport, and anything set explicitly still wins.
 *
 * @param {any} settings - effective configuration
 * @returns {any} the email section with the preset applied
 */
export function resolveEmailSettings(settings) {
  const email = settings?.email ?? {}
  const presetName = sanitizeLine(email.preset ?? '')
  if (presetName === '') return email
  const preset = PROVIDER_PRESETS[presetName]
  if (preset === undefined) return { ...email, presetError: `unknown email preset "${presetName}"` }
  return deepMerge(preset, email)
}

/**
 * Whether SMTP is configured well enough to attempt delivery.
 *
 * @param {any} settings - effective configuration
 * @returns {boolean} true when host, sender and at least one recipient exist
 */
export function emailReady(settings) {
  const email = resolveEmailSettings(settings)
  if (email.enabled === false) return false
  if (sanitizeLine(email.host ?? '') === '') return false
  if (normalizeAddress(email.from) === undefined) return false
  return normalizeRecipients(email.to).length > 0
}

/**
 * Describe the email channel without revealing the secret.
 *
 * @param {any} settings - effective configuration
 * @returns {{ ready: boolean, host: string, port: number, user: string, from: string, to: string[], secretSource: string }}
 *   a redacted view for tool output and logs
 */
export function describeEmail(settings) {
  const email = resolveEmailSettings(settings)
  return {
    ready: emailReady(settings),
    host: sanitizeLine(email.host ?? ''),
    port: Number.isFinite(email.port) ? email.port : 465,
    user: sanitizeLine(email.user ?? ''),
    from: sanitizeLine(email.from ?? ''),
    to: normalizeRecipients(email.to),
    secretSource: secretSourceOf(email),
  }
}

/**
 * Name the source a password would come from, for diagnostics.
 *
 * @param {any} email - the email section
 * @returns {string} `env:NAME`, `command`, `inline`, or `missing`
 */
export function secretSourceOf(email) {
  if (sanitizeLine(email?.pass ?? '') !== '') return 'inline'
  if (sanitizeLine(email?.passCommand ?? '') !== '') return 'command'
  return `env:${sanitizeLine(email?.passEnv ?? '') || 'DSH_SMTP_PASSWORD'}`
}

/**
 * Resolve the SMTP password from the layered sources.
 *
 * @param {any} email - the email section
 * @param {object} [options] - resolution options
 * @param {NodeJS.ProcessEnv} [options.env] - environment to read, defaults to the process
 * @param {(command: string) => Promise<string>} [options.execute] - command runner seam for tests
 * @returns {Promise<string>} the password, or an empty string when none is configured
 */
export async function resolvePass(email, options = {}) {
  const env = options.env ?? process.env
  const inline = typeof email?.pass === 'string' ? email.pass : ''
  if (inline !== '') return inline
  const passEnv = sanitizeLine(email?.passEnv ?? '')
  if (passEnv !== '' && typeof env[passEnv] === 'string' && env[passEnv] !== '') return env[passEnv]
  if (passEnv === '' && typeof env.DSH_SMTP_PASSWORD === 'string' && env.DSH_SMTP_PASSWORD !== '') {
    return env.DSH_SMTP_PASSWORD
  }
  const command = sanitizeLine(email?.passCommand ?? '')
  if (command === '') return ''
  const execute = typeof options.execute === 'function'
    ? options.execute
    : async (line) => {
      const { stdout } = await run('/bin/sh', ['-c', line], { timeout: 10_000 })
      return stdout
    }
  try {
    return String(await execute(command)).trim()
  } catch (error) {
    throw new Error(`dsh-notify: passCommand failed: ${describeError(error)}`)
  }
}

/**
 * Send one notification by email.
 *
 * @param {object} input - send input
 * @param {object} input.event - the notification event
 * @param {any} input.settings - effective configuration
 * @param {string} [input.sessionTitle] - human title of the owning session
 * @param {(options: any) => Promise<any>} [input.transport] - SMTP seam for tests
 * @param {object} [input.secretOptions] - password resolution options
 * @returns {Promise<{ ok: boolean, detail: string, code?: string }>} the delivery outcome
 */
export async function sendEmail(input) {
  const email = resolveEmailSettings(input.settings)
  if (!emailReady(input.settings)) {
    return { ok: false, code: 'EMAIL_NOT_CONFIGURED', detail: 'email is not configured (host/from/to are required)' }
  }
  let message
  try {
    message = buildAlertMessage({ event: input.event, settings: input.settings, sessionTitle: input.sessionTitle })
  } catch (error) {
    return { ok: false, code: 'EMAIL_BUILD', detail: `could not build the message: ${describeError(error)}` }
  }
  if (message === undefined) {
    return { ok: false, code: 'EMAIL_NOT_CONFIGURED', detail: 'email is not configured (host/from/to are required)' }
  }
  let pass = ''
  try {
    pass = await resolvePass(email, input.secretOptions ?? {})
  } catch (error) {
    return { ok: false, code: 'EMAIL_SECRET', detail: describeError(error) }
  }
  const port = Number.isFinite(email.port) && email.port > 0 ? Math.trunc(email.port) : 465
  const transport = typeof input.transport === 'function' ? input.transport : sendMail
  const result = await transport({
    host: sanitizeLine(email.host ?? ''),
    port,
    tls: email.tls,
    requireTls: email.requireTls !== false,
    verifyCert: email.verifyCert !== false,
    preferPlain: email.preferPlain !== false,
    user: sanitizeLine(email.user ?? ''),
    pass,
    from: message.from,
    to: message.to,
    raw: message.raw,
    subject: message.subject,
    messageId: message.messageId,
    heloName: email.heloName,
    timeoutMs: positiveNumber(email.timeoutMs, 20_000),
    allowPortFallback: email.allowPortFallback !== false,
  })
  return { ok: result.ok === true, code: result.code, detail: result.detail ?? '' }
}
