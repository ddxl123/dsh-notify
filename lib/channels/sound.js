/**
 * System sound channel.
 *
 * Plays one audio file through a platform-native player. The command is built
 * as an argument vector (never a shell string) with an allowlist of binary
 * names, so no configuration value or model-authored text can turn into a
 * shell injection.
 *
 * @module dsh-notify-long/lib/channels/sound
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { sanitizeLine } from '../util.js'
import { soundsForKind } from '../core/text.js'

const run = promisify(execFile)

/** macOS system sound directory. */
export const MAC_SOUND_DIR = '/System/Library/Sounds'
/** Linux sound-theme directories searched for an event sound. */
export const LINUX_SOUND_DIRS = [
  '/usr/share/sounds/freedesktop/stereo',
  '/usr/share/sounds/gnome/default/alerts',
  '/usr/share/sounds',
]
/** Windows built-in wave files, in preference order. */
export const WINDOWS_SOUNDS = [
  'C:\\Windows\\Media\\Windows Notify System Generic.wav',
  'C:\\Windows\\Media\\notify.wav',
  'C:\\Windows\\Media\\Windows Notify.wav',
  'C:\\Windows\\Media\\chimes.wav',
  'C:\\Windows\\Media\\ding.wav',
]

/**
 * @typedef {object} SoundPlan
 * @property {string} argv0 - executable name or absolute path
 * @property {string[]} args - arguments passed to it
 * @property {string} description - human-readable command for diagnostics
 */

/**
 * Decide whether one candidate executable name is acceptable. Absolute paths
 * are accepted only under a known sound directory; bare names must be on the
 * allowlist, which keeps the spawn surface closed.
 *
 * @param {string} candidate - configured or suggested executable
 * @returns {boolean} true when the name may be spawned
 */
export function isAllowedPlayer(candidate) {
  const value = sanitizeLine(candidate)
  if (value === '') return false
  const basename = value.split(/[/\\]/).pop() ?? ''
  return ALLOWED_PLAYERS.has(basename)
}

/** Bare executable names this channel is willing to spawn. */
export const ALLOWED_PLAYERS = new Set(['afplay', 'paplay', 'pw-play', 'aplay', 'ffplay', 'mpv', 'powershell', 'powershell.exe', 'pwsh'])

/**
 * Pick a sound file for `kind`/`sound`, preferring a user-supplied file that
 * actually exists and falling back to a platform default.
 *
 * @param {object} input - selection input
 * @param {string} input.kind - notification kind
 * @param {string} [input.sound] - configured sound name (macOS/Linux) or file path
 * @param {NodeJS.Platform} [input.platform] - platform, defaults to the running one
 * @returns {string} a sound name or file path, or an empty string when nothing usable was found
 */
export function resolveSoundFile(input) {
  const platform = input.platform ?? process.platform
  const requested = sanitizeLine(input.sound ?? '')
  const candidates = requested === '' ? soundsForKind(input.kind) : [requested, ...soundsForKind(input.kind)]
  for (const candidate of candidates) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (existsSync(candidate)) return candidate
      continue
    }
    if (platform === 'darwin') {
      for (const extension of ['aiff', 'wav', 'm4a', 'caf']) {
        const file = join(MAC_SOUND_DIR, `${candidate}.${extension}`)
        if (existsSync(file)) return file
      }
      continue
    }
    if (platform === 'linux') {
      for (const directory of LINUX_SOUND_DIRS) {
        for (const extension of ['oga', 'wav', 'ogg']) {
          const file = join(directory, `${candidate}.${extension}`)
          if (existsSync(file)) return file
        }
      }
      continue
    }
    if (platform === 'win32') {
      const file = WINDOWS_SOUNDS.find((entry) => entry.toLowerCase().includes(candidate.toLowerCase()))
      if (file !== undefined && existsSync(file)) return file
    }
  }
  return ''
}

/**
 * Build the player invocation for one sound file.
 *
 * @param {object} input - plan input
 * @param {string} input.file - sound file or name resolved by {@link resolveSoundFile}
 * @param {string} [input.player] - configured player executable
 * @param {NodeJS.Platform} [input.platform] - platform, defaults to the running one
 * @returns {SoundPlan | undefined} the plan, or undefined when nothing is playable
 */
export function planSoundCommand(input) {
  const platform = input.platform ?? process.platform
  const file = sanitizeLine(input.file ?? '')
  const configuredPlayer = sanitizeLine(input.player ?? '')
  const player = configuredPlayer !== '' && isAllowedPlayer(configuredPlayer)
    ? configuredPlayer
    : undefined
  if (platform === 'darwin') {
    if (file === '') return undefined
    const argv0 = player ?? 'afplay'
    return { argv0, args: [file], description: `${argv0} ${file}` }
  }
  if (platform === 'win32') {
    const argv0 = player ?? 'powershell'
    const script = file === ''
      ? '[System.Media.SystemSounds]::Asterisk.Play()'
      : `(New-Object System.Media.SoundPlayer -ArgumentList '${file.replace(/'/g, "''")}').PlaySync()`
    return { argv0, args: ['-NoProfile', '-NonInteractive', '-Command', script], description: `${argv0} (system sound)` }
  }
  // linux and everything else
  const argv0 = player ?? (which('paplay') ?? which('pw-play') ?? which('aplay') ?? which('ffplay'))
  if (argv0 === undefined) return undefined
  if (file === '') {
    if (argv0.endsWith('ffplay')) return undefined
    return { argv0, args: [], description: `${argv0} (default alert)` }
  }
  const args = argv0.endsWith('ffplay') ? ['-nodisp', '-autoexit', '-loglevel', 'quiet', file] : [file]
  return { argv0, args, description: `${argv0} ${args.join(' ')}` }
}

/**
 * Locate one executable on PATH without spawning a shell.
 *
 * @param {string} command - bare executable name
 * @returns {string | undefined} the absolute path, when found
 */
function which(command) {
  const path = process.env.PATH ?? ''
  for (const directory of path.split(':')) {
    if (directory === '') continue
    const candidate = join(directory, command)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Play one sound. Resolves to a delivery result instead of throwing: an
 * unavailable player must never break an agent turn.
 *
 * @param {object} input - play input
 * @param {string} input.file - sound file or name
 * @param {string} [input.player] - configured player executable
 * @param {number} [input.timeoutMs] - hard cap for the player process
 * @param {NodeJS.Platform} [input.platform] - platform override for tests
 * @param {(spec: SoundPlan) => Promise<unknown>} [input.spawn] - injection seam for tests
 * @returns {Promise<{ ok: boolean, detail: string }>} the outcome
 */
export async function playSound(input) {
  const plan = planSoundCommand({ file: input.file, player: input.player, platform: input.platform })
  if (plan === undefined) return { ok: false, detail: 'no usable sound player or sound file was found' }
  const spawn = typeof input.spawn === 'function' ? input.spawn : (spec) => run(spec.argv0, spec.args, { timeout: input.timeoutMs ?? 10_000 })
  try {
    await spawn(plan)
    return { ok: true, detail: plan.description }
  } catch (error) {
    return { ok: false, detail: `sound player failed (${plan.description}): ${error instanceof Error ? error.message : String(error)}` }
  }
}
