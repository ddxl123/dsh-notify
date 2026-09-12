/**
 * Unit tests for notification policy: quiet hours, routing, dedupe and cooldown.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { dedupeKeyOf, Guard, quietHoursState, resolveRoute } from '../lib/core/policy.js'

/** @param {string} clock - `HH:MM` @returns {Date} a local date at that clock time */
function at(clock) {
  const [hours, minutes] = clock.split(':').map(Number)
  const date = new Date(2026, 0, 15, hours, minutes, 0, 0)
  return date
}

test('quiet hours handle a range that wraps midnight', () => {
  const state = (clock) => quietHoursState('22:00', '08:00', at(clock)).active
  assert.equal(state('21:59'), false)
  assert.equal(state('22:00'), true)
  assert.equal(state('23:30'), true)
  assert.equal(state('00:10'), true)
  assert.equal(state('07:59'), true)
  assert.equal(state('08:00'), false)
  assert.equal(state('12:00'), false)
})

test('quiet hours handle a same-day range and an unset range', () => {
  assert.equal(quietHoursState('09:00', '17:00', at('12:00')).active, true)
  assert.equal(quietHoursState('09:00', '17:00', at('08:59')).active, false)
  assert.equal(quietHoursState('09:00', '17:00', at('17:00')).active, false)
  assert.equal(quietHoursState(undefined, undefined, at('12:00')).active, false)
  assert.equal(quietHoursState('09:00', '17:00', at('12:00')).configured, true)
  assert.equal(quietHoursState('oops', '17:00', at('12:00')).configured, false)
})

test('routing drops muted channels, keeps email in quiet hours, and honours per-kind settings', () => {
  const settings = {
    alerts: {
      channels: ['sound', 'desktop', 'email'],
      kinds: { subagent: { enabled: false }, error: { channels: ['email'] } },
    },
  }
  const event = { kind: 'completed', title: 'done', body: '' }
  const quiet = { active: false, configured: false, range: [] }
  assert.deepEqual(resolveRoute({ event, settings, quiet, emailReady: true }).channels, ['sound', 'desktop', 'email'])
  assert.deepEqual(
    resolveRoute({ event, settings, quiet: { active: true, configured: true, range: ['22:00', '08:00'] }, emailReady: true }).channels,
    ['email'],
  )
  assert.deepEqual(resolveRoute({ event, settings, quiet, emailReady: false }).channels, ['sound', 'desktop'])
  assert.equal(resolveRoute({ event: { kind: 'subagent' }, settings, quiet, emailReady: true }).enabled, false)
  assert.deepEqual(resolveRoute({ event: { kind: 'error', urgency: 'error' }, settings, quiet, emailReady: true }).channels, ['email'])
})

test('an error alert forces email even when the global channel list omits it', () => {
  const settings = { alerts: { channels: ['sound'], kinds: {} } }
  const quiet = { active: false, configured: false, range: [] }
  const route = resolveRoute({ event: { kind: 'error', urgency: 'error' }, settings, quiet, emailReady: true })
  assert.deepEqual(route.channels, ['sound', 'email'])
  const withoutSmtp = resolveRoute({ event: { kind: 'error', urgency: 'error' }, settings, quiet, emailReady: false })
  assert.deepEqual(withoutSmtp.channels, ['sound'])
})

test('dedupe keys are stable for the same logical event and differ per turn', () => {
  const base = { kind: 'completed', title: 'Finished', body: 'x', sessionId: 's1', turn: 2 }
  assert.equal(dedupeKeyOf(base), dedupeKeyOf({ ...base }))
  assert.notEqual(dedupeKeyOf(base), dedupeKeyOf({ ...base, turn: 3 }))
  assert.notEqual(dedupeKeyOf(base), dedupeKeyOf({ ...base, sessionId: 's2' }))
})

test('the guard suppresses duplicates inside the window and then forgets', () => {
  let now = 1_000
  const guard = new Guard({ dedupeWindowMs: 5_000, cooldownMs: 0, channelCooldownMs: 0, now: () => now })
  assert.equal(guard.isDuplicate('k'), false)
  assert.equal(guard.isDuplicate('k'), true)
  now += 5_001
  assert.equal(guard.isDuplicate('k'), false)
})

test('the guard applies a cooldown per failure fingerprint', () => {
  let now = 0
  const guard = new Guard({ dedupeWindowMs: 0, cooldownMs: 1_000, channelCooldownMs: 0, now: () => now })
  assert.equal(guard.isCoolingDown('a'), false)
  assert.equal(guard.isCoolingDown('a'), true)
  assert.equal(guard.isCoolingDown('b'), false)
  now += 1_001
  assert.equal(guard.isCoolingDown('a'), false)
})

test('the guard collapses audible burst windows per channel', () => {
  let now = 0
  const guard = new Guard({ dedupeWindowMs: 0, cooldownMs: 0, channelCooldownMs: 1_000, now: () => now })
  assert.equal(guard.isChannelCoolingDown('sound'), false)
  assert.equal(guard.isChannelCoolingDown('sound'), true)
  assert.equal(guard.isChannelCoolingDown('desktop'), false)
  now += 1_001
  assert.equal(guard.isChannelCoolingDown('sound'), false)
})

test('the guard stays bounded', () => {
  const guard = new Guard({ maxEntries: 16 })
  for (let index = 0; index < 200; index += 1) guard.isDuplicate(`key-${index}`)
  assert.ok(guard.seen.size <= 32)
})
