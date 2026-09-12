/**
 * Boot-level test: mount the real plugin module into a fake harness and drive
 * synthetic harness events through it.
 *
 * This is the integration seam the composition relies on — the plugin's own
 * `apply()` wiring, its event subscriptions, and its `notify_*` tools — without
 * needing a full DSH process, a browser, or a mail server.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createFakeHarness, createFakeSettings } from './helpers/fake-harness.js'
import { Engine } from '../lib/core/engine.js'
import { Guard } from '../lib/core/policy.js'
import { Outbox } from '../lib/core/queue.js'
import { Tracker } from '../lib/core/detect.js'
import { createRuntime } from '../lib/runtime/handlers.js'

/** @param {number} ms - milliseconds to wait @returns {Promise<void>} resolves after the delay */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/** @param {string} name - prefix @returns {string} a fresh temp directory */
function tempDir(name) {
  return mkdtempSync(join(tmpdir(), `${name}-`))
}

/**
 * Whether the harness peer packages are resolvable from this checkout.
 *
 * The boot-level tests exercise the real plugin module, which imports
 * `@deepseek-ai/schemastery` and `@deepseek-ai/dsh-tools` at load time. On a
 * machine with a dsh installation, `npm run test:setup` links them into
 * `test/node_modules`; without them (a bare CI checkout) the boot tests are
 * skipped rather than reported as failures.
 *
 * @returns {Promise<boolean>} true when the peers resolve
 */
async function peersAvailable() {
  try {
    await import('@deepseek-ai/schemastery')
    await import('@deepseek-ai/dsh-tools')
    return true
  } catch {
    return false
  }
}

const bootTests = (await peersAvailable()) ? test : test.skip

bootTests('apply() mounts against the real peer packages and registers its tools', async () => {
  const home = tempDir('dsh-notify-long-home')
  process.env.DSH_HOME = home
  const settings = createFakeSettings()
  const harness = createFakeHarness({ services: { settings } })
  const module = await harness.mount({
    // Every channel is switched off so this test never plays audio or opens a
    // banner, while the wiring is still exercised end to end.
    sound: { enabled: false },
    desktop: { enabled: false },
    email: { enabled: false },
    alerts: { channels: ['sound', 'desktop', 'email'] },
    debug: true,
  })

  assert.equal(module.name, 'dsh-notify-long')
  assert.deepEqual(module.inject, ['agents', 'tools'])
  assert.notEqual(module.Config, undefined)
  for (const event of [
    'session/created',
    'agent/created',
    'session/event',
    'agent/status',
    'api-session/status',
    'agent/error',
    'api-session/error',
    'tools/result',
    'user-questions/request',
    'approval/request',
    'subagent/end',
  ]) {
    assert.ok(harness.count(event) > 0, `expected a listener for ${event}`)
  }
  assert.deepEqual(harness.toolNames().sort(), ['notify_flush', 'notify_status', 'notify_test', 'notify_user'])
  // The state directory is created on apply.
  assert.equal(existsSync(join(home, 'dsh-notify-long')), true)
})

bootTests('a finished turn produces a completion alert through the real wiring', async () => {
  const home = tempDir('dsh-notify-long-home')
  process.env.DSH_HOME = home
  const harness = createFakeHarness({
    services: { settings: createFakeSettings() },
    entry: undefined,
  })
  await harness.mount({
    sound: { enabled: false },
    desktop: { enabled: false },
    email: { enabled: false },
    debug: true,
  })

  const session = { id: 'session-abc', header: { cwd: '/tmp/project' } }
  await harness.emit('session/created', session)
  await harness.emit('api-session/status', 'session-abc', true)
  await harness.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  await harness.emit('session/event', session, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'build the release' }] },
  })
  await harness.emit('session/event', session, {
    type: 'tool/result',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'ok' }] } },
  })
  await harness.emit('session/event', session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'the release is built' }] } },
  })
  await harness.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await harness.emit('api-session/status', 'session-abc', false)
  // The idle assessment is deferred by design; wait it out.
  await sleep(500)

  // Nothing is left behind: the alert was attempted through the real wiring and
  // removed once every channel reported its failure.
  const outboxPath = join(home, 'dsh-notify-long', 'outbox.json')
  if (existsSync(outboxPath)) {
    const outbox = JSON.parse(readFileSync(outboxPath, 'utf8'))
    assert.equal(outbox.items.length, 0, 'no alert stays queued when all channels are disabled')
  }
  // The alert reached the engine: the debug log names the state directory.
  assert.ok(harness.logLines().some((line) => line.includes('state directory')), harness.logLines().join('\n'))

  const status = await harness.tool('notify_status').execute({}, {})
  assert.equal(status.enabled, true)
  assert.equal(status.queued, 0)
  assert.deepEqual(status.channels, [], 'every channel is disabled in this configuration')

  const manual = await harness.tool('notify_user').execute(
    { title: 'Manual alert', message: 'hello', urgency: 'info' },
    {},
  )
  // Every channel reports "disabled", so the attempt fails and the alert is
  // held in the durable outbox for a later retry rather than being lost.
  assert.equal(manual.delivered, false)
  assert.match(manual.note, /queued in the durable outbox/)
  assert.ok(manual.failures.length > 0)

  const flush = await harness.tool('notify_flush').execute({}, {})
  assert.equal(flush.queued, 1)
  assert.equal(flush.delivered, 0)
})

bootTests('a failing turn leaves a queued record instead of losing the alert', async () => {
  const home = tempDir('dsh-notify-long-home')
  process.env.DSH_HOME = home
  const harness = createFakeHarness({ services: { settings: createFakeSettings() } })
  await harness.mount({
    sound: { enabled: true, player: 'definitely-not-installed-player' },
    desktop: { enabled: true },
    email: { enabled: true },
    alerts: { channels: ['sound'] },
    debug: true,
  })
  const session = { id: 'session-def', header: { cwd: '/tmp/project' } }
  await harness.emit('session/created', session)
  await harness.emit('api-session/status', 'session-def', true)
  await harness.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
  await harness.emit('agent/error', { agent: { id: 'session-def' }, turn: 1, step: 1, error: new Error('model route exploded') })
  await sleep(200)

  const outbox = JSON.parse(readFileSync(join(home, 'dsh-notify-long', 'outbox.json'), 'utf8'))
  assert.equal(outbox.items.length, 1)
  assert.equal(outbox.items[0].kind, 'error')
  assert.match(outbox.items[0].body, /model route exploded/)
  assert.equal(outbox.items[0].attempts, 1)
  assert.ok(outbox.items[0].notBefore > outbox.items[0].at)
})

bootTests('notify_test reports each channel explicitly', async () => {
  const home = tempDir('dsh-notify-long-home')
  process.env.DSH_HOME = home
  const harness = createFakeHarness({ services: { settings: createFakeSettings() } })
  await harness.mount({ sound: { enabled: false }, desktop: { enabled: false }, email: { enabled: false } })
  const result = await harness.tool('notify_test').execute({ channel: 'email' }, {})
  assert.equal(result.ok, false)
  assert.equal(result.email, 'failed: disabled in settings')
  assert.equal(result.sound, 'not requested')
  assert.equal(result.desktop, 'not requested')
})

test('a question request notifies and the approved turn reports once', async () => {
  const engine = {
    alertCount: 0,
    events: [],
    guard: new Guard(),
    async raise(event) {
      this.alertCount += 1
      this.events.push(event)
      return { delivered: true, channels: ['desktop'], failures: [] }
    },
  }
  const tracker = new Tracker()
  const scheduled = []
  const runtime = createRuntime({
    tracker,
    engine,
    settings: () => ({ alerts: { kinds: {} } }),
    timer: (delay, callback) => {
      scheduled.push(callback)
      return () => undefined
    },
  })
  runtime.noteSession({ sessionId: 's' })
  runtime.status({ sessionId: 's', running: true })
  runtime.question({
    sessionId: 's',
    request: { agent: { id: 's' }, questions: [{ id: 'q1', header: 'Deploy', question: 'Deploy to production?' }] },
  })
  runtime.status({ sessionId: 's', running: false })
  for (const callback of scheduled) callback()
  assert.equal(engine.alertCount, 1, 'the question alert replaces the completion alert for this turn')
  assert.equal(engine.events[0].kind, 'question')
})

test('an approval request notifies with the tool that needs permission', async () => {
  const engine = {
    events: [],
    guard: new Guard(),
    async raise(event) {
      this.events.push(event)
      return { delivered: true, channels: ['desktop'], failures: [] }
    },
  }
  const tracker = new Tracker()
  const runtime = createRuntime({ tracker, engine, settings: () => ({ alerts: { kinds: {} } }) })
  runtime.noteSession({ sessionId: 's2', cwd: '/repo' })
  runtime.approval({ sessionId: 's2', request: { agent: { id: 's2' }, toolName: 'bash', reason: 'writes outside the workspace' } })
  assert.equal(engine.events.length, 1)
  assert.equal(engine.events[0].kind, 'approval')
  assert.match(engine.events[0].title, /bash/)
  assert.match(engine.events[0].body, /writes outside the workspace/)
})

test('the subagent opt-in is honoured by the runtime', async () => {
  const engine = {
    events: [],
    guard: new Guard(),
    async raise(event) {
      this.events.push(event)
      return { delivered: true, channels: [], failures: [] }
    },
  }
  const tracker = new Tracker()
  const runtime = createRuntime({ tracker, engine, settings: () => ({ alerts: { kinds: {} } }) })
  runtime.noteSession({ sessionId: 'child', parentSession: 'root' })
  tracker.noteTurnStart('child')
  tracker.noteSessionEvent('child', 'tool/call', {})
  tracker.noteTurnEnd('child', 1, { kind: 'completed' })
  runtime.finish('child', tracker.noteStatus('child', 'idle'))
  assert.equal(engine.events.length, 0)

  runtime.subagentEnd({ sessionId: 'child', info: { runId: 'run-1', stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'subtask done' }] } })
  assert.equal(engine.events.length, 0, 'subagent/end is opt-in too')

  const enabled = createRuntime({
    tracker,
    engine,
    settings: () => ({ alerts: { kinds: { subagent: { enabled: true } } } }),
  })
  enabled.subagentEnd({ sessionId: 'child', info: { runId: 'run-2', stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'subtask done' }] } })
  assert.equal(engine.events.length, 1)
  assert.match(engine.events[0].body, /subtask done/)
})

test('the engine keeps working when every channel is broken', async () => {
  const home = tempDir('dsh-notify-long-home')
  const outbox = new Outbox({ path: join(home, 'outbox.json') })
  const engine = new Engine({
    outbox,
    guard: new Guard(),
    settings: () => ({ enabled: true, alerts: { channels: ['email'], kinds: {} }, email: {}, quietHours: {} }),
    emailReady: () => true,
    playSound: async () => ({ ok: false, detail: 'no player' }),
    showDesktop: async () => ({ ok: false, detail: 'no backend' }),
    sendEmail: async () => ({ ok: false, detail: 'smtp refused' }),
  })
  const outcome = await engine.raise({ kind: 'completed', title: 'x', body: 'y', at: Date.now() })
  assert.equal(outcome.delivered, false)
  assert.equal(outcome.queued, true)
  assert.equal(outbox.size, 1)
  assert.equal(engine.status().failed, 1)
  assert.match(engine.status().lastFailure, /smtp refused/)
})
