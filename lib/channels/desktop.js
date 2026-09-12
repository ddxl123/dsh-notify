/**
 * Desktop notification channel: a native banner in the operator's notification
 * centre, on macOS, Linux and Windows.
 *
 * As with the sound channel, every spawned command is an argument vector with
 * sanitized text, never a shell string.
 *
 * @module dsh-notify/lib/channels/desktop
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { clip, sanitizeLine, sanitizeText } from '../util.js'
import { kindLabel } from '../core/text.js'

const run = promisify(execFile)

/** Hard cap on the banner body, so a long agent answer stays readable. */
export const BODY_LIMIT = 320

/** @returns {string | undefined} the host name used in the banner title */
function hostName() {
  return sanitizeLine(process.env.DSH_NOTIFY_HOSTNAME ?? '') || undefined
}

/**
 * @typedef {object} DesktopPlan
 * @property {string} argv0 - executable
 * @property {string[]} args - arguments
 * @property {string} description - printable command for diagnostics
 */

/**
 * Build the platform command for one desktop notification.
 *
 * @param {object} input - plan input
 * @param {string} input.title - banner title
 * @param {string} input.body - banner body
 * @param {string} input.kind - notification kind, used for the mac subtitle
 * @param {string} [input.sound] - macOS sound name played with the banner, or `none`
 * @param {NodeJS.Platform} [input.platform] - platform override for tests
 * @returns {DesktopPlan | undefined} the plan, or undefined when the platform has no supported banner
 */
export function planDesktopCommand(input) {
  const platform = input.platform ?? process.platform
  const title = clip(sanitizeLine(input.title), 120) || 'DeepSeek Harness'
  const body = clip(sanitizeText(input.body).replace(/\n+/g, ' '), BODY_LIMIT)
  if (platform === 'darwin') {
    const sound = sanitizeLine(input.sound ?? '')
    const soundClause = sound === '' || sound === 'none' ? '' : ` sound name "${sound}"`
    const script = `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}" subtitle "${escapeAppleScript(kindLabel(input.kind))}"${soundClause}`
    return { argv0: 'osascript', args: ['-e', script], description: `osascript display notification: ${title}` }
  }
  if (platform === 'win32') {
    const script = [
      '[reflection.assembly]::loadwithpartialname("System.Windows.Forms") | Out-Null',
      '[System.Windows.Forms.MessageBox]::Show(',
      `'${body.replace(/'/g, "''")}',`,
      `'${title.replace(/'/g, "''")}',`,
      '[System.Windows.Forms.MessageBoxButtons]::OK,',
      '[System.Windows.Forms.MessageBoxIcon]::Information) | Out-Null',
    ].join(' ')
    return { argv0: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', script], description: `powershell notification: ${title}` }
  }
  const appName = hostName() ?? 'DeepSeek Harness'
  return {
    argv0: 'notify-send',
    args: ['--app-name', appName, '--urgency', input.kind === 'error' ? 'critical' : 'normal', title, body],
    description: `notify-send: ${title}`,
  }
}

/**
 * Escape text for an AppleScript double-quoted string literal.
 *
 * @param {string} text - raw text
 * @returns {string} escaped text with newlines flattened
 */
export function escapeAppleScript(text) {
  return String(text ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')
}

/**
 * Show one desktop notification.
 *
 * @param {object} input - show input
 * @param {string} input.title - banner title
 * @param {string} input.body - banner body
 * @param {string} input.kind - notification kind
 * @param {string} [input.sound] - macOS banner sound, or `none` to stay silent
 * @param {number} [input.timeoutMs] - hard cap for the helper process
 * @param {NodeJS.Platform} [input.platform] - platform override for tests
 * @param {(plan: DesktopPlan) => Promise<unknown>} [input.spawn] - injection seam for tests
 * @returns {Promise<{ ok: boolean, detail: string }>} the outcome
 */
export async function showDesktop(input) {
  const plan = planDesktopCommand(input)
  if (plan === undefined) return { ok: false, detail: 'no desktop notification backend for this platform' }
  const spawn = typeof input.spawn === 'function'
    ? input.spawn
    : (spec) => run(spec.argv0, spec.args, { timeout: input.timeoutMs ?? 10_000 })
  try {
    await spawn(plan)
    return { ok: true, detail: plan.description }
  } catch (error) {
    return { ok: false, detail: `desktop notification failed (${plan.description}): ${error instanceof Error ? error.message : String(error)}` }
  }
}
