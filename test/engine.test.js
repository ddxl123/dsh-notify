/**
 * Engine, outbox and tracker tests: the decision layer, exercised with fake
 * channels so no real sound, banner or mail server is involved.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Engine } from '../lib/core/engine.js'
import { Guard, quietHoursState } from '../lib/core/policy.js'
import { makeRecord, Outbox } from '../lib/core/queue.js'
import { Tracker } from '../lib/core/detect.js'
import { createRuntime } from '../lib/runtime/handlers.js'

/** @returns {string} a fresh temporary directory */
function tempDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-notify-long-test-'))
}

/** @returns {any} a channel recorder */
function recorder(ok = true, detail = 'ok') {
  const calls = []
  return {
    calls,
    fn: async (input) => {
      calls.push(input)
      return { ok, detail }
    },
  }
}

/**
 * Build an engine over fake channels.
 *
 * @param {object} [options] - test options
 * @returns {any} the engine plus its recorders
 */
function makeEngine(options = {}) {
  const dir = options.dir ?? tempDir()
  const outbox = new Outbox({ path: join(dir, 'outbox.json'), now: options.now })
  const settings = () => ({
    enabled: true,
    alerts: { channels: ['sound', 'desktop', 'email'], dedupeWindowMs: 300_000, errorCooldownMs: 600_000, channelCooldownMs: 15_000, kinds: {}, ...options.alerts },
    quietHours: options.quietHours ?? {},
    email: options.email ?? {},
    sound: options.sound ?? {},
    desktop: options.desktop ?? {},
  })
  const sound = recorder(options.soundOk ?? true, options.soundDetail ?? 'played')
  const desktop = recorder(options.desktopOk ?? true, options.desktopDetail ?? 'shown')
  const email = recorder(options.emailOk ?? true, options.emailDetail ?? 'sent')
  const engine = new Engine({
    outbox,
    guard: new Guard({
      dedupeWindowMs: options.alerts?.dedupeWindowMs,
      cooldownMs: options.alerts?.errorCooldownMs,
      channelCooldownMs: options.alerts?.channelCooldownMs,
      now: options.now,
    }),
    settings,
    emailReady: () => options.emailReady ?? true,
    playSound: sound.fn,
    showDesktop: desktop.fn,
    sendEmail: email.fn,
    log: () => {},
    now: options.now,
  })
  return { engine, outbox, sound, desktop, email, dir, settings }
}

const EVENT = { kind: 'completed', title: 'Finished: demo', body: 'done', sessionId: 's1', turn: 1, urgency: 'action' }

test('an alert reaches every configured channel exactly once', async () => {
  const { engine, sound, desktop, email, outbox } = makeEngine()
  const outcome = await engine.raise(EVENT)
  assert.equal(outcome.delivered, true)
  assert.deepEqual(outcome.channels, ['sound', 'desktop', 'email'])
  assert.equal(sound.calls.length, 1)
  assert.equal(desktop.calls.length, 1)
  assert.equal(email.calls.length, 1)
  assert.equal(outbox.size, 0)
})

test('a duplicate event inside the window is suppressed', async () => {
  const { engine, email } = makeEngine()
  await engine.raise(EVENT)
  const second = await engine.raise(EVENT)
  assert.equal(second.delivered, false)
  assert.equal(second.skipped, 'duplicate within the suppression window')
  assert.equal(email.calls.length, 1)
})

test('quiet hours mute sound and desktop but still send email', async () => {
  const now = new Date(2026, 0, 15, 23, 30).getTime()
  const { engine, sound, desktop, email } = makeEngine({
    quietHours: { start: '22:00', end: '08:00' },
    now: () => now,
    soundOk: false,
    soundDetail: 'must not be attempted during quiet hours',
    desktopOk: false,
    desktopDetail: 'must not be attempted during quiet hours',
  })
  const outcome = await engine.raise({ ...EVENT, at: now })
  assert.equal(outcome.delivered, true)
  assert.deepEqual(outcome.channels, ['email'])
  assert.equal(outcome.failures.length, 0)
  assert.equal(sound.calls.length, 0)
  assert.equal(desktop.calls.length, 0)
  assert.equal(email.calls.length, 1)
})

test('a disabled kind is not delivered at all', async () => {
  const { engine, sound } = makeEngine({ alerts: { kinds: { completed: { enabled: false } } } })
  const outcome = await engine.raise(EVENT)
  assert.equal(outcome.delivered, false)
  assert.equal(outcome.skipped, 'disabled by configuration')
  assert.equal(sound.calls.length, 0)
})

test('a failing channel is retried with backoff and then dropped after the attempt cap', async () => {
  let now = 1_800_000_000_000
  const { engine, outbox, email } = makeEngine({
    emailOk: false,
    emailDetail: 'smtp down',
    soundOk: false,
    desktopOk: false,
    now: () => now,
    alerts: { channels: ['email'] },
  })
  const first = await engine.raise({ ...EVENT, at: now })
  assert.equal(first.delivered, false)
  assert.equal(first.queued, true)
  assert.equal(outbox.size, 1)
  assert.equal(outbox.items[0].attempts, 1)
  assert.ok(outbox.items[0].notBefore > now)
  for (let attempt = 0; attempt < 8 && outbox.size > 0; attempt += 1) {
    now = outbox.items[0].notBefore ?? now
    await engine.drain()
  }
  assert.equal(outbox.size, 0, 'the record is abandoned after the attempt cap')
  assert.equal(email.calls.length, 5)
})

test('a record that succeeds on a later drain leaves the outbox', async () => {
  let fail = true
  const dir = tempDir()
  const { engine, outbox } = makeEngine({ dir })
  engine.sendEmail = async () => (fail ? { ok: false, detail: 'smtp down' } : { ok: true, detail: 'sent' })
  engine.playSound = async () => ({ ok: false, detail: 'no player' })
  engine.showDesktop = async () => ({ ok: false, detail: 'no backend' })
  engine.settings = () => ({ enabled: true, alerts: { channels: ['email'], kinds: {} }, email: {}, quietHours: {} })
  await engine.raise({ ...EVENT, at: Date.now() })
  assert.equal(outbox.size, 1)
  fail = false
  outbox.retryAll()
  const summary = await engine.drain()
  assert.equal(summary.delivered, 1)
  assert.equal(outbox.size, 0)
})

test('the outbox persists records and drops stale ones', () => {
  const dir = tempDir()
  const path = join(dir, 'outbox.json')
  const clock = 1_800_000_000_000
  const outbox = new Outbox({ path, now: () => clock })
  outbox.load()
  outbox.add(makeRecord({ kind: 'completed', title: 'kept', body: '', at: clock - 1_000 }))
  outbox.add(makeRecord({ kind: 'completed', title: 'stale', body: '', at: clock - 30 * 60 * 60 * 1000 }))
  assert.equal(outbox.size, 2)
  const reloaded = new Outbox({ path, now: () => clock })
  const result = reloaded.load()
  assert.equal(result.loaded, 1)
  assert.equal(result.dropped, 1)
  assert.equal(reloaded.items[0].title, 'kept')
  assert.match(readFileSync(path, 'utf8'), /"kept"/)
})

test('a corrupt outbox file is reset instead of throwing', () => {
  const dir = tempDir()
  const path = join(dir, 'outbox.json')
  writeFileSync(path, '{not json', 'utf8')
  const outbox = new Outbox({ path })
  const messages = []
  outbox.onError = (message) => messages.push(message)
  const result = outbox.load()
  assert.deepEqual(result, { loaded: 0, dropped: 0 })
  assert.equal(messages.length, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('a digest squashes several queued records into one alert', async () => {
  const { engine, outbox, email } = makeEngine()
  outbox.add(makeRecord({ kind: 'error', title: 'one', body: '', at: Date.now() }))
  outbox.add(makeRecord({ kind: 'question', title: 'two', body: '', at: Date.now() }))
  const squashed = engine.squash('quiet hours')
  assert.equal(squashed, 2)
  assert.equal(outbox.size, 1)
  const outcome = await engine.digest(outbox.items)
  assert.equal(outcome.delivered, true)
  assert.match(email.calls[0].event.body, /- \[error\] one/)
})

test('engine.status reports readiness without secrets', async () => {
  const { engine } = makeEngine()
  const status = engine.status()
  assert.equal(status.enabled, true)
  assert.equal(status.emailReady, true)
  assert.equal(status.queued, 0)
  assert.equal(typeof status.lastFailure === 'undefined' || typeof status.lastFailure === 'string', true)
})

test('the tracker folds a turn into a completion alert and ignores empty turns', () => {
  const tracker = new Tracker()
  tracker.noteSession('s1', { cwd: '/tmp/x' })
  tracker.seedStatus('s1', 'idle')
  tracker.noteStatus('s1', 'running')
  tracker.noteTurnStart('s1')
  tracker.noteUserMessage('s1', { source: { kind: 'user' }, content: [{ type: 'text', text: 'build the thing' }] })
  tracker.noteSessionEvent('s1', 'tool/call', {})
  tracker.noteSessionEvent('s1', 'assistant/message', { message: { content: [{ type: 'text', text: 'all done' }] } })
  const end = tracker.noteTurnEnd('s1', 1, { kind: 'completed' })
  assert.equal(end.notify, true)
  assert.equal(end.message, 'all done')
  const transition = tracker.noteStatus('s1', 'idle')
  assert.equal(transition.becameIdle, true)
  assert.equal(transition.pending, undefined)
  assert.equal(transition.facts.title, 'build the thing')

  tracker.noteStatus('s1', 'running')
  tracker.noteTurnStart('s1')
  const empty = tracker.noteTurnEnd('s1', 2, { kind: 'completed' })
  assert.equal(empty.notify, false)
})

test('the tracker flags a question and reports it on the idle transition', () => {
  const tracker = new Tracker()
  tracker.seedStatus('s2', 'idle')
  tracker.noteStatus('s2', 'running')
  tracker.noteTurnStart('s2')
  tracker.noteSessionEvent('s2', 'assistant/message', { message: { content: [{ type: 'text', text: 'which one?' }] } })
  tracker.notePending('s2', 'question')
  const transition = tracker.noteStatus('s2', 'idle')
  assert.equal(transition.pending, 'question')
  // The flag is consumed exactly once.
  tracker.noteStatus('s2', 'running')
  tracker.noteStatus('s2', 'idle')
  assert.equal(tracker.noteStatus('s2', 'idle').becameIdle, false)
})

test('the tracker marks subagent sessions from their session header', () => {
  const tracker = new Tracker()
  tracker.noteSession('child', { parent: 'parent' })
  tracker.noteSession('root', {})
  assert.equal(tracker.isSubagent('child'), true)
  assert.equal(tracker.isSubagent('root'), false)
})

test('the tracker fingerprints repeated errors', () => {
  const tracker = new Tracker()
  const first = tracker.noteError('s3', { error: new Error('boom'), stage: 'turn' })
  const second = tracker.noteError('s3', { error: new Error('boom'), stage: 'turn' })
  assert.match(first.message, /boom/)
  assert.equal(first.fingerprint, second.fingerprint)
  assert.equal(tracker.factsOf('s3').errors, 2)
})

test('the runtime raises a question alert with the question text', async () => {
  const engine = { guard: new Guard(), raise: async (event) => { engine.events.push(event); return { delivered: true, channels: ['email'], failures: [] } }, events: [] }
  const tracker = new Tracker()
  const runtime = createRuntime({ tracker, engine, settings: () => ({ alerts: { kinds: {} } }) })
  runtime.noteSession({ sessionId: 'sess', cwd: '/repo' })
  runtime.question({
    sessionId: 'sess',
    request: {
      agent: { id: 'sess' },
      questions: [{ id: 'q1', header: 'Database', question: 'Which database?', options: [{ label: 'sqlite' }, { label: 'postgres' }] }],
    },
  })
  assert.equal(engine.events.length, 1)
  assert.equal(engine.events[0].kind, 'question')
  assert.match(engine.events[0].title, /Database/)
  assert.match(engine.events[0].body, /sqlite \| postgres/)
})

test('the runtime raises an error alert once per fingerprint cooldown', () => {
  const engine = { guard: new Guard({ cooldownMs: 60_000 }), raise: async (event) => { engine.events.push(event); return { delivered: true, channels: [], failures: [] } }, events: [] }
  const tracker = new Tracker()
  const runtime = createRuntime({ tracker, engine, settings: () => ({ alerts: { kinds: {} } }) })
  runtime.noteSession({ sessionId: 'sess' })
  runtime.error({ sessionId: 'sess', error: new Error('same failure'), stage: 'turn' })
  runtime.error({ sessionId: 'sess', error: new Error('same failure'), stage: 'turn' })
  runtime.error({ sessionId: 'sess', error: new Error('different failure'), stage: 'turn' })
  assert.equal(engine.events.length, 2)
  assert.equal(engine.events[0].kind, 'error')
  assert.equal(engine.events[0].urgency, 'error')
})

test('the runtime skips subagent completion until it is enabled', () => {
  const engine = { guard: new Guard(), raise: async () => ({ delivered: true, channels: [], failures: [] }), count: 0 }
  engine.raise = async () => { engine.count += 1; return { delivered: true, channels: [], failures: [] } }
  const tracker = new Tracker()
  const runtime = createRuntime({ tracker, engine, settings: () => ({ alerts: { kinds: {} } }) })
  runtime.noteSession({ sessionId: 'child', parentSession: 'root' })
  tracker.noteTurnStart('child')
  tracker.noteSessionEvent('child', 'tool/call', {})
  tracker.noteTurnEnd('child', 1, { kind: 'completed' })
  runtime.finish('child', tracker.noteStatus('child', 'idle'))
  assert.equal(engine.count, 0)

  const enabled = { guard: new Guard(), events: [], raise: async (event) => { enabled.events.push(event); return { delivered: true, channels: [], failures: [] } } }
  const runtime2 = createRuntime({ tracker, engine: enabled, settings: () => ({ alerts: { kinds: { subagent: { enabled: true } } } }) })
  runtime2.finish('child', { facts: tracker.factsOf('child') })
  assert.equal(enabled.events.length, 1)
  assert.equal(enabled.events[0].kind, 'subagent')
})

test('the runtime defers the idle assessment so a question can win the race', async () => {
  const scheduled = []
  const engine = { guard: new Guard(), events: [], raise: async (event) => { engine.events.push(event); return { delivered: true, channels: [], failures: [] } } }
  const tracker = new Tracker()
  const runtime = createRuntime({
    tracker,
    engine,
    settings: () => ({ alerts: { kinds: {} } }),
    timer: (delay, callback) => {
      scheduled.push({ delay, callback })
      return () => undefined
    },
  })
  runtime.noteSession({ sessionId: 's' })
  runtime.status({ sessionId: 's', running: true })
  tracker.noteTurnStart('s')
  tracker.noteSessionEvent('s', 'tool/call', {})
  tracker.noteTurnEnd('s', 1, { kind: 'completed' })
  runtime.status({ sessionId: 's', running: false })
  assert.equal(scheduled.length, 1, 'the idle assessment is deferred')
  // The question arrives after the status transition, as it does in practice.
  runtime.question({ sessionId: 's', request: { questions: [{ id: 'q', question: 'Continue?' }] } })
  assert.equal(engine.events.length, 1)
  scheduled[0].callback()
  assert.equal(engine.events.length, 1, 'the deferred completion alert is skipped once a question was raised')
  assert.equal(engine.events[0].kind, 'question')
})

test('quietHoursState is exported consistently for the runtime diagnostic', () => {
  assert.equal(quietHoursState('22:00', '08:00', new Date(2026, 0, 1, 23, 0)).active, true)
})
