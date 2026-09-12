/**
 * Unit tests for the sound and desktop channel planners: argument vectors,
 * player allowlisting, and per-platform command shapes.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { escapeAppleScript, planDesktopCommand } from '../lib/channels/desktop.js'
import { ALLOWED_PLAYERS, isAllowedPlayer, planSoundCommand, resolveSoundFile } from '../lib/channels/sound.js'

test('the player allowlist rejects arbitrary executables and shell metacharacters', () => {
  assert.equal(isAllowedPlayer('afplay'), true)
  assert.equal(isAllowedPlayer('/usr/bin/afplay'), true)
  assert.equal(isAllowedPlayer('rm'), false)
  assert.equal(isAllowedPlayer('afplay; rm -rf /'), false)
  assert.equal(isAllowedPlayer(''), false)
  assert.equal(isAllowedPlayer('/bin/sh'), false)
  assert.equal(ALLOWED_PLAYERS.has('afplay'), true)
})

test('the macOS plan always passes the sound file as one argument', () => {
  const plan = planSoundCommand({ file: '/System/Library/Sounds/Glass.aiff', platform: 'darwin' })
  assert.deepEqual(plan, {
    argv0: 'afplay',
    args: ['/System/Library/Sounds/Glass.aiff'],
    description: 'afplay /System/Library/Sounds/Glass.aiff',
  })
  assert.equal(planSoundCommand({ file: '', platform: 'darwin' }), undefined)
})

test('a hostile player setting degrades to the platform default', () => {
  const plan = planSoundCommand({ file: '/tmp/x.aiff', player: 'bash -c rm', platform: 'darwin' })
  assert.equal(plan?.argv0, 'afplay')
  assert.deepEqual(plan?.args, ['/tmp/x.aiff'])
})

test('the Linux plan uses ffplay flags when ffplay is chosen', () => {
  const plan = planSoundCommand({ file: '/usr/share/sounds/freedesktop/stereo/bell.oga', player: 'ffplay', platform: 'linux' })
  assert.equal(plan?.argv0, 'ffplay')
  assert.deepEqual(plan?.args, ['-nodisp', '-autoexit', '-loglevel', 'quiet', '/usr/share/sounds/freedesktop/stereo/bell.oga'])
})

test('the Windows plan quotes the wave path inside the PowerShell script', () => {
  const plan = planSoundCommand({ file: "C:\\Media\\it's a sound.wav", platform: 'win32' })
  assert.equal(plan?.argv0, 'powershell')
  assert.match(plan?.args.join(' ') ?? '', /it''s a sound\.wav/)
})

test('resolveSoundFile falls back to a platform default for an unknown name', () => {
  const resolved = resolveSoundFile({ kind: 'completed', sound: 'definitely-not-a-sound', platform: 'darwin' })
  assert.match(resolved, /\/System\/Library\/Sounds\/(Glass|Hero)\.(aiff|wav|m4a|caf)$/)
})

test('the macOS desktop plan uses display notification with an escaped title', () => {
  const plan = planDesktopCommand({ title: 'say "hi"\nnow', body: 'line one\nline two', kind: 'error', sound: 'none', platform: 'darwin' })
  assert.equal(plan?.argv0, 'osascript')
  assert.equal(plan?.args[0], '-e')
  assert.match(plan?.args[1] ?? '', /display notification "line one line two" with title "say \\"hi\\" now" subtitle "error"/)
  assert.equal((plan?.args[1] ?? '').includes('sound name'), false)
})

test('the macOS desktop plan plays the banner sound when configured', () => {
  const plan = planDesktopCommand({ title: 't', body: 'b', kind: 'completed', sound: 'Glass', platform: 'darwin' })
  assert.match(plan?.args[1] ?? '', /sound name "Glass"/)
})

test('the Linux desktop plan builds a notify-send argument vector', () => {
  const plan = planDesktopCommand({ title: 'Build done', body: 'ok', kind: 'error', platform: 'linux' })
  assert.equal(plan?.argv0, 'notify-send')
  assert.deepEqual(plan?.args.slice(0, 2), ['--app-name', 'DeepSeek Harness'])
  assert.ok(plan?.args.includes('critical'))
  assert.ok(plan?.args.includes('Build done'))
})

test('escapeAppleScript escapes quotes, backslashes and newlines', () => {
  assert.equal(escapeAppleScript('a"b\\c\nd'), 'a\\"b\\\\c d')
})
