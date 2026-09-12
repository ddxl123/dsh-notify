/**
 * dsh-notify-long — DeepSeek Harness notification plugin.
 *
 * A subscribe-side Cordis plugin: it watches the harness for the moments that
 * need a human (a finished task, a failure, a question, an approval) and alerts
 * the operator over system sound, a desktop banner, and email — with a durable
 * outbox so an alert survives a reload or a temporary delivery failure.
 *
 * Everything decision-shaped lives in `lib/`; this file only reads services,
 * subscribes to events, and registers the model-facing `notify_*` tools.
 *
 * @module dsh-notify-long
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { deepMerge, describeError, sanitizeLine } from '../lib/util.js'
import { Guard } from '../lib/core/policy.js'
import { Outbox } from '../lib/core/queue.js'
import { Engine } from '../lib/core/engine.js'
import { Tracker } from '../lib/core/detect.js'
import { planSoundCommand, playSound, resolveSoundFile } from '../lib/channels/sound.js'
import { showDesktop } from '../lib/channels/desktop.js'
import { describeEmail, emailReady, sendEmail } from '../lib/channels/email.js'
import { createRuntime } from '../lib/runtime/handlers.js'

/** Cordis plugin name shown in loader diagnostics. */
export const name = 'dsh-notify-long'

/** Services this plugin consumes; the plugin waits until they all exist. */
export const inject = ['agents', 'tools']

/**
 * Optional peer modules. Resolved through `await import` so a deployment
 * without them degrades the affected capability (configuration defaults,
 * `defineTool` validation) instead of failing the whole composition.
 */
const schemastery = await optionalImport('@deepseek-ai/schemastery')
const defineToolModule = await optionalImport('@deepseek-ai/dsh-tools')

/**
 * Import an optional peer dependency.
 *
 * @param {string} specifier - bare module specifier
 * @returns {Promise<any | undefined>} the module namespace, or undefined when it cannot be resolved
 */
async function optionalImport(specifier) {
  try {
    return await import(specifier)
  } catch {
    return undefined
  }
}

/**
 * Composition entry schema.
 *
 * Cordis validates a row's `config` with `Config['~standard'].validate(...)`
 * *before* `apply` runs, so whatever this module exports must be a Standard
 * Schema or nothing at all. Two shapes were possible and only one is safe:
 *
 * - a real schema, when `@deepseek-ai/schemastery` resolves, so the harness gets
 *   validation and the documented defaults;
 * - `undefined`, when it does not, which makes Cordis skip config validation
 *   entirely.
 *
 * A plain function is NOT a substitute. It has no `~standard`, so Cordis reads
 * `Config['~standard'].validate` off `undefined` and the whole plugin tree fails
 * to load — a degraded capability turning into a dead harness. `defaultsFor`
 * still applies every default inside `apply`, so the plugin behaves identically
 * either way; only validation is lost.
 *
 * Resolution is a peer-dependency question, not a code one: Node resolves a
 * linked package's bare imports from its *real* path, so an out-of-tree plugin
 * cannot see the harness's `profiles/node_modules` fallback unless the package
 * is also resolvable from its own directory. Declaring the peer dependency (and
 * installing it, or using a published one) is what makes the schema branch
 * reachable.
 */
export const Config = resolveConfigSchema()

/**
 * Build the config schema, or `undefined` when no schema module is available.
 *
 * @returns {any} a Standard Schema, or undefined to let Cordis skip validation
 */
function resolveConfigSchema() {
  const z = schemastery?.default ?? schemastery?.z ?? schemastery
  if (z === undefined || typeof z.object !== 'function') return undefined
  try {
    const schema = buildConfigSchema(z)
    // Guard the exact contract Cordis reads, so a future shape change degrades to
    // "no validation" instead of a load failure.
    return typeof schema?.['~standard']?.validate === 'function' ? schema : undefined
  } catch {
    return undefined
  }
}

/**
 * Build the schemastery configuration schema. The harness validates a row's
 * `config` against this schema before `apply` runs, which is where the
 * documented defaults come from.
 *
 * @param {any} z - the schemastery module
 * @returns {any} the schema
 */
function buildConfigSchema(z) {
  const channel = z.union(['sound', 'desktop', 'email'])
  return z.object({
    enabled: z.boolean().default(true),
    sound: z.object({
      enabled: z.boolean().default(true),
      file: z.string(),
      player: z.string(),
      perKind: z.dict(z.string()),
      timeoutMs: z.natural().default(10_000),
    }),
    desktop: z.object({
      enabled: z.boolean().default(true),
      titlePrefix: z.string(),
      sound: z.string(),
    }),
    email: z.object({
      enabled: z.boolean().default(true),
      preset: z.union(['qq', 'qq-exmail', '163', '163-enterprise', 'aliyun', 'gmail', 'outlook', 'office365', 'icloud', 'zoho', 'yahoo', 'sendgrid', 'mailgun', 'resend', 'brevo']),
      host: z.string(),
      port: z.natural().default(465),
      tls: z.union(['implicit', 'starttls', 'plain']),
      user: z.string(),
      pass: z.string().role('secret'),
      passEnv: z.string().default('DSH_SMTP_PASSWORD'),
      passCommand: z.string(),
      from: z.string(),
      to: z.union([z.string(), z.array(z.string())]).default([]),
      cc: z.union([z.string(), z.array(z.string())]).default([]),
      subjectPrefix: z.string().default('[DSH]'),
      html: z.boolean().default(true),
      requireTls: z.boolean().default(true),
      verifyCert: z.boolean().default(true),
      preferPlain: z.boolean().default(true),
      allowPortFallback: z.boolean().default(true),
      heloName: z.string(),
      timeoutMs: z.natural().default(20_000),
    }),
    quietHours: z.object({
      start: z.string(),
      end: z.string(),
    }),
    alerts: z.object({
      channels: z.array(channel).default(['sound', 'desktop', 'email']),
      dedupeWindowMs: z.natural().default(300_000),
      errorCooldownMs: z.natural().default(600_000),
      channelCooldownMs: z.natural().default(15_000),
      kinds: z.dict(z.object({
        enabled: z.boolean().default(true),
        channels: z.array(channel),
      })),
    }),
    outbox: z.object({
      path: z.string(),
      flushOnStart: z.boolean().default(true),
    }),
    tools: z.object({
      enabled: z.boolean().default(true),
    }),
    log: z.object({
      delivered: z.boolean().default(true),
      failures: z.boolean().default(true),
    }),
    debug: z.boolean().default(false),
  })
}

/**
 * Apply the documented defaults to a raw configuration. Used when schemastery
 * is unavailable, and to make every nested section present for direct readers.
 *
 * @param {any} value - raw configuration
 * @returns {any} the configuration with defaults filled in
 */
export function defaultsFor(value) {
  return deepMerge({
    enabled: true,
    sound: { enabled: true, perKind: {}, timeoutMs: 10_000 },
    desktop: { enabled: true },
    email: {
      enabled: true,
      port: 465,
      passEnv: 'DSH_SMTP_PASSWORD',
      to: [],
      cc: [],
      subjectPrefix: '[DSH]',
      html: true,
      requireTls: true,
      verifyCert: true,
      preferPlain: true,
      allowPortFallback: true,
      timeoutMs: 20_000,
    },
    quietHours: {},
    alerts: {
      channels: ['sound', 'desktop', 'email'],
      dedupeWindowMs: 300_000,
      errorCooldownMs: 600_000,
      channelCooldownMs: 15_000,
      kinds: {},
    },
    outbox: { flushOnStart: true },
    tools: { enabled: true },
    log: { delivered: true, failures: true },
    debug: false,
  }, value)
}

/**
 * Resolve the directory holding this plugin's durable state.
 *
 * @param {any} ctx - the plugin context
 * @returns {string} `<DSH_HOME or ~/.dsh>/dsh-notify-long`
 */
export function stateDirectory(ctx) {
  if (typeof ctx?.get === 'function') {
    const paths = ctx.get('paths')
    if (paths !== undefined && typeof paths.home === 'string' && paths.home !== '') return join(paths.home, 'dsh-notify-long')
  }
  const home = sanitizeLine(process.env.DSH_HOME ?? '') || join(sanitizeLine(process.env.HOME ?? '') || '.', '.dsh')
  return join(home, 'dsh-notify-long')
}

/**
 * Register the plugin.
 *
 * @param {any} ctx - the loader-provided plugin context
 * @param {any} rawConfig - the validated composition entry
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const entry = defaultsFor(rawConfig)
  const debug = entry.debug === true
  const log = createLogger(ctx, entry, debug)
  const settings = ctx.get('settings')

  /** @type {() => any} */
  let source = () => entry
  const engineHolder = { current: undefined }
  if (settings !== undefined) {
    try {
      settings.installSection(ctx, 'dsh-notify-long', Config, entry, {
        setSource: (current) => { source = current },
        onChange: () => {
          log.debug('notification settings changed')
          engineHolder.current?.guard.reset()
        },
      })
    } catch (error) {
      log.warn(`could not attach the settings section; using the composition entry only (${describeError(error)})`)
    }
  }
  const settingsNow = () => source() ?? entry

  const stateDir = stateDirectory(ctx)
  try {
    mkdirSync(stateDir, { recursive: true })
  } catch (error) {
    log.warn(`could not create the state directory ${stateDir} (${describeError(error)})`)
  }

  const outbox = new Outbox({
    path: sanitizeLine(settingsNow().outbox?.path ?? '') || join(stateDir, 'outbox.json'),
    onError: (message) => log.warn(message),
  })
  const guard = new Guard({
    dedupeWindowMs: settingsNow().alerts?.dedupeWindowMs,
    cooldownMs: settingsNow().alerts?.errorCooldownMs,
    channelCooldownMs: settingsNow().alerts?.channelCooldownMs,
  })
  const emailConfigured = () => emailReady(settingsNow())
  const engine = new Engine({
    outbox,
    guard,
    settings: settingsNow,
    emailReady: emailConfigured,
    playSound: (input) => (settingsNow().sound?.enabled === false
      ? Promise.resolve({ ok: false, detail: 'sound is disabled in settings' })
      : playSound(input)),
    showDesktop: (input) => (settingsNow().desktop?.enabled === false
      ? Promise.resolve({ ok: false, detail: 'desktop notifications are disabled in settings' })
      : showDesktop(input)),
    sendEmail: (input) => (settingsNow().email?.enabled === false
      ? Promise.resolve({ ok: false, detail: 'email is disabled in settings' })
      : sendEmail(input)),
    log: (message) => log.warn(message),
  })
  engineHolder.current = engine

  const tracker = new Tracker()
  const runtime = createRuntime({
    tracker,
    engine,
    settings: settingsNow,
    log: (message) => log.warn(message),
  })
  ctx.on('dispose', () => runtime.dispose())

  // Each subscription group is guarded independently: if one harness event
  // disappears in a future release, only that capability goes quiet instead of
  // the whole composition failing to load.
  subscribe(ctx, log, 'session lifecycle', () => {
    ctx.on('session/created', (session) => {
      const header = session?.header ?? {}
      runtime.noteSession({
        sessionId: String(session?.id ?? ''),
        ...header.cwd === undefined ? {} : { cwd: header.cwd },
        ...header.parentSession === undefined ? {} : { parentSession: String(header.parentSession) },
      })
    })
    ctx.on('agent/created', (payload) => {
      const sessionId = String(payload?.agent?.id ?? '')
      if (sessionId !== '') runtime.noteSession({ sessionId })
    })
  })

  subscribe(ctx, log, 'session events', () => {
    ctx.on('session/event', (session, event) => {
      const sessionId = String(session?.id ?? '')
      if (sessionId === '') return
      runtime.sessionEvent(sessionId, String(event?.type ?? ''), event?.data)
    })
  })

  subscribe(ctx, log, 'agent status', () => {
    ctx.on('agent/status', (payload) => {
      const sessionId = String(payload?.agent?.id ?? '')
      if (sessionId === '') return
      runtime.status({ sessionId, status: payload?.status === 'running' ? 'running' : 'idle' })
    })
    ctx.on('api-session/status', (sessionId, running) => {
      runtime.status({ sessionId: String(sessionId ?? ''), running: running === true })
    })
  })

  subscribe(ctx, log, 'agent errors', () => {
    ctx.on('agent/error', (payload) => {
      const sessionId = String(payload?.agent?.id ?? '')
      if (sessionId === '') return
      runtime.error({
        sessionId,
        error: payload?.error,
        stage: payload?.step === undefined ? 'turn' : 'step',
        turn: payload?.turn,
        step: payload?.step,
      })
    })
    ctx.on('api-session/error', (sessionId, message) => {
      if (String(sessionId ?? '') === '') return
      runtime.error({ sessionId: String(sessionId), error: message, stage: 'session' })
    })
  })

  subscribe(ctx, log, 'tool results', () => {
    ctx.on('tools/result', (exec, result) => {
      const sessionId = String(exec?.agent?.id ?? '')
      if (sessionId === '') return
      runtime.toolResult({ sessionId, toolName: String(exec?.name ?? ''), result })
    })
  })

  subscribe(ctx, log, 'user questions', () => {
    ctx.on('user-questions/request', (request, next) => {
      const sessionId = String(request?.agent?.id ?? '')
      if (sessionId !== '') runtime.question({ sessionId, request })
      return next()
    })
  })

  subscribe(ctx, log, 'approval requests', () => {
    ctx.on('approval/request', (request, next) => {
      const sessionId = String(request?.agent?.id ?? '')
      if (sessionId !== '') runtime.approval({ sessionId, request })
      return next()
    })
  })

  subscribe(ctx, log, 'subagent completions', () => {
    ctx.on('subagent/end', (info) => {
      const sessionId = String(info?.id ?? '')
      if (sessionId !== '') runtime.subagentEnd({ sessionId, info })
    })
  })

  if (entry.tools?.enabled !== false) {
    registerTools(ctx, { engine, tracker, outbox, settingsNow, emailConfigured, log })
  }

  const restored = outbox.load()
  log.debug(`state directory ${stateDir}; ${restored.loaded} queued alert(s) restored, ${restored.dropped} stale record(s) dropped`)
  if (outbox.size > 0) {
    engine.drain().then((summary) => {
      if (summary.delivered > 0 || summary.failed > 0) {
        log.info(`alert outbox flushed: ${summary.delivered} delivered, ${summary.failed} deferred, ${summary.dropped} dropped`)
      }
    }).catch((error) => log.warn(`could not flush the alert outbox (${describeError(error)})`))
  }
}

/**
 * Run one subscription group, reporting — but never propagating — a failure.
 *
 * @param {any} ctx - the plugin context
 * @param {{ warn: Function }} log - the logger
 * @param {string} label - what is being subscribed
 * @param {() => void} register - the subscriptions
 * @returns {void}
 */
function subscribe(ctx, log, label, register) {
  try {
    register()
  } catch (error) {
    log.warn(`could not subscribe to ${label}; that capability is inactive (${describeError(error)})`)
  }
}

/**
 * Register the model-facing `notify_*` tools.
 *
 * @param {any} ctx - the plugin context
 * @param {object} deps - tool dependencies
 * @returns {void}
 */
function registerTools(ctx, deps) {
  for (const tool of [
    defineNotifyTool(deps),
    defineTestTool(deps),
    defineStatusTool(deps),
    defineFlushTool(deps),
  ]) {
    try {
      ctx.tools.register(tool)
    } catch (error) {
      deps.log.warn(`could not register the ${tool.name} tool (${describeError(error)})`)
    }
  }
}

/**
 * Build one tool definition through the harness `defineTool` when it is
 * resolvable, or a shape-compatible literal when it is not.
 *
 * @param {any} options - definition options
 * @returns {any} the registry-ready definition
 */
function defineHarnessTool(options) {
  if (typeof defineToolModule?.defineTool === 'function') return defineToolModule.defineTool(options)
  return { ...options, output: { schema: { type: 'json' }, render: options.output.render } }
}

/**
 * The `notify_user` tool: an explicit, model-initiated alert.
 *
 * @param {object} deps - tool dependencies
 * @returns {any} the tool definition
 */
function defineNotifyTool(deps) {
  const { engine, tracker } = deps
  return defineHarnessTool({
    name: 'notify_user',
    description: [
      'Send the operator an out-of-band notification (system sound, desktop banner, email) without ending the turn.',
      'Use it when a long unattended job finishes, when you are about to wait on something, or when the operator asked to be told.',
      'urgency "action" means a human must act before work can continue; "error" marks a failure.',
      'Do not use it for routine progress narration: the harness already alerts on finished turns, failures, questions and approvals.',
    ].join(' '),
    parameters: {
      title: {
        type: 'string',
        required: true,
        description: 'One short line describing the alert, for example "Nightly build finished".',
      },
      message: {
        type: 'string',
        description: 'Body of the alert: what happened and what the operator should do next.',
      },
      urgency: {
        type: 'string',
        enum: ['info', 'action', 'error'],
        description: 'info (default) for a notice, action when a human must act, error for a failure.',
      },
      sound: {
        type: 'string',
        description: 'Optional sound override for this alert: a macOS system sound name, or a path to an audio file.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          delivered: { type: 'boolean', required: true },
          channels: { type: 'array', required: true, items: { type: 'string' } },
          failures: { type: 'array', required: true, items: { type: 'string' } },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.delivered
          ? `Alert delivered over: ${value.channels.join(', ') || 'none'}.`
          : `Alert not delivered${value.failures.length === 0 ? '' : `: ${value.failures.join('; ')}`}.`,
      }],
    },
    async execute(args, exec) {
      const sessionId = exec?.agent?.id === undefined ? undefined : String(exec.agent.id)
      const urgency = args.urgency === 'action' || args.urgency === 'error' ? args.urgency : 'info'
      const facts = sessionId === undefined ? undefined : tracker.factsOf(sessionId)
      const sound = sanitizeLine(args.sound ?? '')
      const outcome = await engine.raise({
        kind: urgency === 'action' ? 'question' : urgency === 'error' ? 'error' : 'manual',
        title: sanitizeLine(args.title) || 'Notification from the agent',
        body: sanitizeLine(args.message ?? ''),
        sessionId,
        sessionTitle: facts?.title,
        cwd: facts?.cwd,
        urgency,
        fingerprint: `manual:${sanitizeLine(args.title)}`,
        ...sound === '' ? {} : { sound },
      })
      return {
        delivered: outcome.delivered === true,
        channels: outcome.channels,
        failures: outcome.failures,
        ...outcome.skipped === undefined ? {} : { note: outcome.skipped },
        ...outcome.queued === true
          ? { note: `delivery failed (${outcome.failures.join('; ')}); the alert is queued in the durable outbox and will be retried` }
          : {},
      }
    },
  })
}

/**
 * The `notify_test` tool: deliver a test alert over the requested channels and
 * report exactly what worked, so the operator can verify their setup.
 *
 * @param {object} deps - tool dependencies
 * @returns {any} the tool definition
 */
function defineTestTool(deps) {
  const { engine, settingsNow, emailConfigured, outbox } = deps
  return defineHarnessTool({
    name: 'notify_test',
    description: 'Send a test notification over the configured channels (system sound, desktop banner, email) and report which ones worked. Use it to verify or debug the operator\'s alert setup.',
    parameters: {
      channel: {
        type: 'string',
        enum: ['all', 'sound', 'desktop', 'email'],
        description: 'Which channel to exercise; defaults to all configured channels.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          sound: { type: 'string', required: true },
          desktop: { type: 'string', required: true },
          email: { type: 'string', required: true },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          value.ok ? 'Test alert sent.' : 'Test alert could not be sent.',
          `sound: ${value.sound}`,
          `desktop: ${value.desktop}`,
          `email: ${value.email}`,
          ...value.note === undefined ? [] : [value.note],
        ].join('\n'),
      }],
    },
    async execute(args) {
      const settings = settingsNow()
      const requested = args?.channel ?? 'all'
      const results = { sound: 'not requested', desktop: 'not requested', email: 'not requested' }
      const at = Date.now()
      const title = 'dsh-notify-long test alert'
      const body = `Verification requested at ${new Date(at).toLocaleString()}.`

      if (requested === 'all' || requested === 'sound') {
        const configuredSound = settings.sound?.perKind?.test ?? settings.sound?.file
        const file = resolveSoundFile({ kind: 'test', sound: configuredSound })
        if (settings.sound?.enabled === false) results.sound = 'disabled in settings'
        else if (planSoundCommand({ file, player: settings.sound?.player }) === undefined) results.sound = 'no usable player or sound file on this machine'
        else {
          const outcome = await engine.playSound({ file, kind: 'test', player: settings.sound?.player, timeoutMs: settings.sound?.timeoutMs })
          results.sound = outcome.ok ? `played (${outcome.detail})` : `failed: ${outcome.detail}`
        }
      }
      if (requested === 'all' || requested === 'desktop') {
        const outcome = settings.desktop?.enabled === false
          ? { ok: false, detail: 'disabled in settings' }
          : await engine.showDesktop({ title, body, kind: 'test', sound: settings.desktop?.sound })
        results.desktop = outcome.ok ? `shown (${outcome.detail})` : `failed: ${outcome.detail}`
      }
      if (requested === 'all' || requested === 'email') {
        const outcome = settings.email?.enabled === false
          ? { ok: false, detail: 'disabled in settings' }
          : await engine.sendEmail({ event: { kind: 'test', title, body, at, urgency: 'info' }, settings })
        results.email = outcome.ok ? `sent (${outcome.detail})` : `failed: ${outcome.detail}`
        if (!emailConfigured()) {
          results.email = settings.email?.enabled === false ? results.email : 'not configured: set email.host, email.from and email.to'
        }
      }
      const ok = Object.values(results).some((entry) => /^(played|shown|sent)/.test(entry))
      return {
        ok,
        ...results,
        ...outbox.size === 0 ? {} : { note: `${outbox.size} alert(s) are still queued for delivery` },
      }
    },
  })
}

/**
 * The `notify_status` tool: report channel readiness and queue state.
 *
 * @param {object} deps - tool dependencies
 * @returns {any} the tool definition
 */
function defineStatusTool(deps) {
  const { engine, settingsNow, outbox } = deps
  return defineHarnessTool({
    name: 'notify_status',
    description: 'Report the operator notification setup: which channels are active, whether email is configured, quiet hours, and how many alerts are queued. Secrets are never included.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          enabled: { type: 'boolean', required: true },
          channels: { type: 'array', required: true, items: { type: 'string' } },
          quiet: { type: 'string', required: true },
          queued: { type: 'integer', required: true },
          delivered: { type: 'integer', required: true },
          failed: { type: 'integer', required: true },
          email: { type: 'string', required: true },
          lastFailure: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `notifications: ${value.enabled ? 'enabled' : 'disabled'}; channels: ${value.channels.join(', ') || 'none'}`,
          `email: ${value.email}`,
          `quiet hours: ${value.quiet}`,
          `queued: ${value.queued}; delivered this run: ${value.delivered}; failed: ${value.failed}`,
          ...value.lastFailure === undefined ? [] : [`last failure: ${value.lastFailure}`],
        ].join('\n'),
      }],
    },
    async execute() {
      const settings = settingsNow()
      const status = engine.status()
      const email = describeEmail(settings)
      return {
        enabled: status.enabled,
        channels: (settings.alerts?.channels ?? []).filter((channel) => {
          if (channel === 'sound') return settings.sound?.enabled !== false
          if (channel === 'desktop') return settings.desktop?.enabled !== false
          return email.ready
        }),
        quiet: status.quiet.configured
          ? `${status.quiet.range[0]}–${status.quiet.range[1]}${status.quiet.active ? ' (active now: sound and desktop muted, email still sent)' : ''}`
          : 'not configured',
        queued: outbox.size,
        delivered: status.delivered,
        failed: status.failed,
        email: email.ready
          ? `ready via ${email.host}:${email.port} as ${email.user || email.from} → ${email.to.join(', ')} (secret: ${email.secretSource})`
          : 'not configured: set email.host, email.from and email.to',
        ...status.lastFailure === undefined ? {} : { lastFailure: status.lastFailure },
      }
    },
  })
}

/**
 * The `notify_flush` tool: retry everything the outbox is holding.
 *
 * @param {object} deps - tool dependencies
 * @returns {any} the tool definition
 */
function defineFlushTool(deps) {
  const { engine, outbox } = deps
  return defineHarnessTool({
    name: 'notify_flush',
    description: 'Retry every notification still waiting in the durable outbox (for example after fixing the email password) and report the outcome.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          queued: { type: 'integer', required: true },
          delivered: { type: 'integer', required: true },
          failed: { type: 'integer', required: true },
          dropped: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Outbox flushed: ${value.delivered} delivered, ${value.failed} deferred, ${value.dropped} dropped (${value.queued} had been queued).`,
      }],
    },
    async execute() {
      const queued = outbox.size
      outbox.retryAll()
      const summary = await engine.drain()
      return { queued, ...summary }
    },
  })
}

/**
 * Build the plugin logger.
 *
 * @param {any} ctx - the plugin context
 * @param {any} config - the composition entry
 * @param {boolean} debug - whether debug logging is on
 * @returns {{ info: Function, warn: Function, debug: Function }} the logger
 */
function createLogger(ctx, config, debug) {
  const logger = ctx.logger ?? ctx.get?.('logger')
  const quiet = config.log?.delivered === false
  const emit = (level, message) => {
    if (quiet && level === 'info') return
    try {
      if (logger !== undefined && typeof logger[level] === 'function') logger[level]('[dsh-notify-long] %s', message)
      else if (level === 'warn') console.warn(`[dsh-notify-long] ${message}`)
      else console.log(`[dsh-notify-long] ${message}`)
    } catch {
      // Logging must never be the reason an alert fails.
    }
  }
  return {
    info: (message) => emit('info', message),
    warn: (message) => emit('warn', message),
    debug: (message) => { if (debug) emit('info', message) },
  }
}

export default { name, inject, Config, apply }
