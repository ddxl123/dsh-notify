#!/usr/bin/env node
/**
 * Deliver a test alert from the command line, outside the harness.
 *
 * Useful for verifying channel configuration (audible sound, banner, SMTP
 * credentials) before restarting dsh, and for debugging a machine where the
 * plugin reports a delivery failure.
 *
 * Usage:
 *   node scripts/test-alert.mjs [--kind completed|question|error|test] [--channel all|sound|desktop|email]
 *                              [--title "..."] [--message "..."] [--json]
 *
 * Configuration comes from the same layers the plugin uses: the environment
 * (DSH_SMTP_PASSWORD), plus optional JSON at $DSH_HOME/dsh-notify-long/config.json.
 * The file is a flat object shaped like the plugin's own settings section:
 *
 *   { "email": { "preset": "qq", "user": "me@qq.com",
 *                "from": "me@qq.com", "to": ["me@qq.com"] } }
 *
 * `preset` accepts qq, qq-exmail, 163, 163-enterprise, aliyun, gmail, outlook,
 * office365, icloud, zoho, yahoo, sendgrid, mailgun, resend or brevo, and fills
 * in host/port/transport for that provider.
 *
 * @module dsh-notify-long/scripts/test-alert
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { playSound } from '../lib/channels/sound.js'
import { showDesktop } from '../lib/channels/desktop.js'
import { describeEmail, emailReady, resolveEmailSettings, sendEmail } from '../lib/channels/email.js'
import { planSoundCommand, resolveSoundFile } from '../lib/channels/sound.js'
import { deepMerge, sanitizeLine } from '../lib/util.js'

/** @param {string[]} argv - process arguments @returns {Record<string, any>} parsed flags */
function parseArgs(argv) {
  const options = { kind: 'test', channel: 'all', title: 'dsh-notify-long test alert', message: 'Manual verification from the command line.', json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--kind') options.kind = argv[index += 1]
    else if (token === '--channel') options.channel = argv[index += 1]
    else if (token === '--title') options.title = argv[index += 1]
    else if (token === '--message') options.message = argv[index += 1]
    else if (token === '--json') options.json = true
    else if (token === '--help' || token === '-h') options.help = true
    else throw new Error(`unknown argument: ${token}`)
  }
  return options
}

/** @returns {any} the configuration, merged from the optional file and the environment */
function loadConfig() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const file = join(home, 'dsh-notify-long', 'config.json')
  const fromFile = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  const fromEnv = process.env.DSH_SMTP_HOST === undefined ? {} : {
    email: {
      host: process.env.DSH_SMTP_HOST,
      ...process.env.DSH_SMTP_PORT === undefined ? {} : { port: Number(process.env.DSH_SMTP_PORT) },
      ...process.env.DSH_SMTP_USER === undefined ? {} : { user: process.env.DSH_SMTP_USER },
      ...process.env.DSH_SMTP_FROM === undefined ? {} : { from: process.env.DSH_SMTP_FROM },
      ...process.env.DSH_SMTP_TO === undefined ? {} : { to: process.env.DSH_SMTP_TO.split(',') },
    },
  }
  const merged = deepMerge({ sound: {}, desktop: {}, email: {} }, { ...fromFile, ...fromEnv, email: deepMerge(fromFile.email ?? {}, fromEnv.email ?? {}) })
  merged.email = resolveEmailSettings(merged)
  return merged
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  console.log(`Usage: node scripts/test-alert.mjs [--kind test] [--channel all] [--title "..."] [--message "..."] [--json]`)
  process.exit(0)
}

const settings = loadConfig()
const results = {}
const at = Date.now()

if (options.channel === 'all' || options.channel === 'sound') {
  const file = resolveSoundFile({ kind: options.kind, sound: settings.sound?.perKind?.[options.kind] ?? settings.sound?.file })
  if (planSoundCommand({ file, player: settings.sound?.player }) === undefined) results.sound = 'no usable player or sound file on this machine'
  else {
    const outcome = await playSound({ file, kind: options.kind, player: settings.sound?.player })
    results.sound = outcome.ok ? `played (${outcome.detail})` : `failed: ${outcome.detail}`
  }
}

if (options.channel === 'all' || options.channel === 'desktop') {
  const outcome = await showDesktop({ title: sanitizeLine(options.title), body: sanitizeLine(options.message), kind: options.kind, sound: settings.desktop?.sound })
  results.desktop = outcome.ok ? `shown (${outcome.detail})` : `failed: ${outcome.detail}`
}

if (options.channel === 'all' || options.channel === 'email') {
  if (!emailReady(settings)) results.email = `not configured: ${describeEmail(settings).host === '' ? 'set email.host, email.from and email.to' : 'set email.from and email.to'}`
  else {
    const outcome = await sendEmail({ event: { kind: options.kind, title: options.title, body: options.message, at, urgency: 'info' }, settings })
    results.email = outcome.ok ? `sent (${outcome.detail})` : `failed: ${outcome.detail}`
  }
}

if (options.json) console.log(JSON.stringify(results, undefined, 2))
else for (const [channel, detail] of Object.entries(results)) console.log(`${channel}: ${detail}`)
const ok = Object.values(results).some((entry) => /^(played|shown|sent)/.test(entry))
process.exitCode = ok ? 0 : 1
