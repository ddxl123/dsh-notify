/**
 * Harness-facing runtime: folds Cordis events into alert decisions.
 *
 * The Cordis plugin in `src/index.js` only subscribes and forwards; every rule
 * lives here so it can be unit-tested with synthetic payloads and a fake engine.
 *
 * @module dsh-notify/lib/runtime/handlers
 */

import { hostname, userInfo } from 'node:os'

import { describeError, sanitizeLine } from '../util.js'
import { completionBody, completionTitle, contentToString, previewToolResult } from '../core/detect.js'
import { errorFingerprint } from '../core/engine.js'

/** Delay before a status transition is acted on, so listeners that raise pending flags settle first. */
export const IDLE_DELAY_MS = 250

/**
 * Default timer implementation: plain timers, tracked by the caller.
 *
 * @param {number} delayMs - delay before the callback runs
 * @param {() => void} callback - the work
 * @returns {() => void} a cancel function
 */
export function defaultTimer(delayMs, callback) {
  const handle = setTimeout(callback, delayMs)
  if (typeof handle.unref === 'function') handle.unref()
  return () => clearTimeout(handle)
}

/**
 * @typedef {object} RuntimeDeps
 * @property {import('../core/detect.js').Tracker} tracker - per-session fact fold
 * @property {import('../core/engine.js').Engine} engine - alert engine
 * @property {() => any} settings - effective configuration accessor
 * @property {(delayMs: number, callback: () => void) => () => void} [timer] - cancellable delayed callback
 * @property {(message: string) => void} [log] - diagnostic sink
 * @property {() => string} [machine] - machine name used in alert bodies
 * @property {() => string} [operator] - operator name used in alert bodies
 */

/**
 * Build the runtime object the Cordis layer drives.
 *
 * @param {RuntimeDeps} deps - runtime dependencies
 * @returns {object} the runtime, with one method per handled event
 */
export function createRuntime(deps) {
  const { tracker, engine } = deps
  const settings = deps.settings
  const timer = typeof deps.timer === 'function' ? deps.timer : defaultTimer
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  const machine = typeof deps.machine === 'function' ? deps.machine : () => safeHostname()
  const operator = typeof deps.operator === 'function' ? deps.operator : () => safeUser()
  /** @type {Set<() => void>} */
  const cancels = new Set()
  /** @type {Map<string, string>} pending question text by session */
  const questionText = new Map()

  /**
   * Schedule work that is cancelled when the plugin unloads.
   *
   * @param {number} delayMs - delay before the callback runs
   * @param {() => void} callback - the work
   * @returns {void}
   */
  const schedule = (delayMs, callback) => {
    const cancel = timer(delayMs, () => {
      cancels.delete(cancel)
      try {
        callback()
      } catch (error) {
        log(`dsh-notify: scheduled handler failed (${describeError(error)})`)
      }
    })
    cancels.add(cancel)
  }

  /** @param {string} sessionId - owning session @returns {string | undefined} the best known title */
  const titleOf = (sessionId) => tracker.factsOf(sessionId)?.title

  /** @param {string} sessionId - owning session @returns {string | undefined} the session working directory */
  const cwdOf = (sessionId) => tracker.factsOf(sessionId)?.cwd

  /** @returns {string} `host (user)` identifying this machine and operator */
  const context = () => `${machine()} (${operator()})`

  /**
   * Raise one alert without ever letting a failure escape into the harness.
   *
   * @param {import('../core/policy.js').NotificationEvent} event - the alert
   * @param {number} [delayMs] - defer dispatch, for events whose details arrive slightly later
   * @returns {void}
   */
  const fire = (event, delayMs = 0) => {
    const dispatch = () => {
      engine.raise(event).catch((error) => {
        log(`dsh-notify: alert dispatch failed (${describeError(error)})`)
      })
    }
    if (delayMs > 0) schedule(delayMs, dispatch)
    else dispatch()
  }

  /**
   * Decide and raise the alert for a session that just stopped running.
   *
   * @param {string} sessionId - session id
   * @param {object} transition - the transition returned by the tracker
   * @param {'question' | 'approval' | 'error'} [transition.pending] - the pending flag raised this turn
   * @param {any} transition.facts - folded session facts
   * @returns {void}
   */
  const finish = (sessionId, transition) => {
    const config = settings()
    const facts = tracker.factsOf(sessionId) ?? transition.facts ?? { id: sessionId, sawPrompt: false }
    const subagent = tracker.isSubagent(sessionId)
    if (subagent && config?.alerts?.kinds?.subagent?.enabled !== true) return
    const pending = transition.pending
    if (pending === 'error') {
      if (config?.alerts?.kinds?.error?.enabled === false) return
      const failure = facts.lastError ?? { message: 'the turn failed', fingerprint: errorFingerprint(sessionId, 'turn failed') }
      fire({
        kind: 'error',
        title: `Failed: ${truncate(titleOf(sessionId) ?? 'agent turn')}`,
        body: failure.message,
        ...facts.reply === undefined ? {} : { detail: truncate(facts.reply, 400) },
        hint: 'Open the session to see the failure and retry the step.',
        sessionId,
        sessionTitle: titleOf(sessionId),
        cwd: cwdOf(sessionId),
        turn: facts.lastTurn,
        urgency: 'error',
        fingerprint: failure.fingerprint,
      })
      return
    }
    if (pending === 'question' || pending === 'approval') {
      return // the question/approval listener already alerted for this turn
    }
    if (config?.alerts?.kinds?.completed?.enabled === false) return
    const turn = facts.lastTurn
    fire({
      kind: subagent ? 'subagent' : 'completed',
      title: subagent
        ? `Subagent finished: ${truncate(titleOf(sessionId) ?? sessionId)}`
        : completionTitle(facts, titleOf(sessionId)),
      body: completionBody(facts, turn),
      sessionId,
      sessionTitle: titleOf(sessionId),
      cwd: cwdOf(sessionId),
      turn,
      urgency: 'action',
      fingerprint: `turn:${turn ?? 'unknown'}`,
    })
  }

  const runtime = {
    /** Cancel every scheduled callback. */
    dispose() {
      for (const cancel of cancels) cancel()
      cancels.clear()
    },

    /**
     * `agent/created` / `session/created`: remember identity facts.
     *
     * @param {object} input - identity input
     * @param {string} input.sessionId - session id
     * @param {string} [input.cwd] - working directory
     * @param {string} [input.parentSession] - parent session id, marking a subagent
     * @param {string} [input.title] - session title
     * @returns {void}
     */
    noteSession(input) {
      tracker.noteSession(input.sessionId, {
        ...input.cwd === undefined ? {} : { cwd: input.cwd },
        ...input.parentSession === undefined ? {} : { parent: input.parentSession },
        ...input.title === undefined ? {} : { title: input.title },
      })
      tracker.seedStatus(input.sessionId, 'idle')
    },

    /**
     * `api-session/status` and `agent/status`: act on a running ⇄ idle transition.
     *
     * @param {object} input - status input
     * @param {string} input.sessionId - session id
     * @param {boolean} [input.running] - whether the session is running
     * @param {string} [input.status] - `idle` | `running`, when the caller has it
     * @returns {void}
     */
    status(input) {
      const running = input.running ?? input.status === 'running'
      const transition = tracker.noteStatus(input.sessionId, running ? 'running' : 'idle')
      if (running || !transition.becameIdle) return
      // A question or approval usually arrives just before the idle transition,
      // but its payload can follow it; let those listeners settle first, then
      // read the pending flag as it stands at dispatch time.
      schedule(IDLE_DELAY_MS, () => finish(input.sessionId, { ...transition, pending: tracker.consumePending(input.sessionId) }))
    },

    /**
     * Decide and raise the alert for a session that just stopped running.
     * Exposed for tests and for callers that already know the transition.
     *
     * @param {string} sessionId - session id
     * @param {object} transition - the tracker transition
     * @returns {void}
     */
    finish,

    /**
     * One `session/event` append.
     *
     * @param {string} sessionId - owning session
     * @param {string} type - session event type
     * @param {any} data - session event payload
     * @returns {void}
     */
    sessionEvent(sessionId, type, data) {
      if (type === 'user/message') {
        tracker.noteUserMessage(sessionId, data)
        return
      }
      if (type === 'turn/start') {
        tracker.noteTurnStart(sessionId)
        return
      }
      if (type === 'turn/end') {
        const assessment = tracker.noteTurnEnd(sessionId, Number(data?.turn ?? 0), data?.reason)
        if (!assessment.failed && !assessment.aborted && assessment.notify && assessment.message !== undefined) {
          tracker.noteSession(sessionId).reply = assessment.message
        }
        return
      }
      tracker.noteSessionEvent(sessionId, type, data)
    },

    /**
     * `tools/result`: clear a pending question once the operator answered, and
     * fold tool outcomes into the session facts.
     *
     * @param {object} input - tool result input
     * @param {string} [input.sessionId] - owning session
     * @param {string} input.toolName - the tool that ran
     * @param {any} input.result - the tool result
     * @returns {void}
     */
    toolResult(input) {
      const sessionId = input.sessionId
      if (sessionId === undefined) return
      if (input.toolName === 'ask_user_question' || input.toolName === 'exit_plan_mode') {
        questionText.delete(sessionId)
        return
      }
      tracker.noteSessionEvent(sessionId, 'tool/result', normalizeToolResult(input.result))
    },

    /**
     * `tools/execute`: observe tool calls and, for a question tool, remember its
     * text so a later alert can quote it.
     *
     * @param {object} input - execution input
     * @param {string} [input.sessionId] - owning session
     * @param {string} input.toolName - tool name
     * @param {any} input.args - parsed arguments
     * @returns {void}
     */
    toolCall(input) {
      const sessionId = input.sessionId
      if (sessionId === undefined) return
      tracker.noteSessionEvent(sessionId, 'tool/call', {})
      if (input.toolName !== 'ask_user_question') return
      const questions = Array.isArray(input.args?.questions) ? input.args.questions : []
      const first = questions[0]
      if (first === undefined) return
      questionText.set(sessionId, truncate([first.header, first.question].filter(Boolean).join(' — '), 300))
    },

    /**
     * `user-questions/request`: the agent is blocked on the operator.
     *
     * @param {object} input - question input
     * @param {string} [input.sessionId] - owning session
     * @param {any} input.request - the question request
     * @returns {void}
     */
    question(input) {
      const sessionId = input.sessionId
      if (sessionId === undefined) return
      tracker.notePending(sessionId, 'question')
      const questions = Array.isArray(input.request?.questions) ? input.request.questions : []
      const first = questions[0]
      const body = questions
        .slice(0, 5)
        .map((entry, index) => {
          const options = Array.isArray(entry?.options)
            ? entry.options.map((option) => sanitizeLine(option?.label)).filter(Boolean)
            : []
          const head = `${index + 1}. ${sanitizeLine(entry?.question ?? entry?.header ?? '')}`
          return options.length === 0 ? head : `${head}\n   options: ${options.join(' | ')}`
        })
        .join('\n')
      fire({
        kind: 'question',
        title: `Needs your input: ${truncate(sanitizeLine(first?.header ?? first?.question ?? titleOf(sessionId) ?? 'question'))}`,
        body: [body, '', context()].filter((line) => line !== '').join('\n'),
        hint: 'Answer in the DeepSeek Harness so the agent can continue.',
        sessionId,
        sessionTitle: titleOf(sessionId),
        cwd: cwdOf(sessionId),
        urgency: 'action',
        fingerprint: `question:${truncate(sanitizeLine(first?.question ?? ''), 120)}`,
      })
    },

    /**
     * `approval/request`: an action needs the operator's permission.
     *
     * @param {object} input - approval input
     * @param {string} [input.sessionId] - owning session
     * @param {any} input.request - the approval request
     * @returns {void}
     */
    approval(input) {
      const sessionId = input.sessionId
      if (sessionId === undefined) return
      tracker.notePending(sessionId, 'approval')
      const request = input.request ?? {}
      const what = sanitizeLine(request.toolName ?? request.tool ?? request.kind ?? 'an action')
      const reason = sanitizeLine(request.reason ?? request.description ?? '')
      fire({
        kind: 'approval',
        title: `Approval needed: ${truncate(what)}`,
        body: [reason === '' ? `The agent is waiting for permission to run ${what}.` : reason, '', context()].join('\n'),
        hint: 'Approve or reject the request in the DeepSeek Harness.',
        sessionId,
        sessionTitle: titleOf(sessionId),
        cwd: cwdOf(sessionId),
        urgency: 'action',
        fingerprint: `approval:${truncate(what, 80)}`,
      })
    },

    /**
     * `agent/error` and `api-session/error`: a step, turn, or session failed.
     *
     * @param {object} input - error input
     * @param {string} [input.sessionId] - owning session
     * @param {any} input.error - the thrown value
     * @param {string} [input.stage] - `turn` | `step` | `session`
     * @param {number} [input.turn] - turn number
     * @param {number} [input.step] - step number
     * @returns {void}
     */
    error(input) {
      const sessionId = input.sessionId
      if (sessionId === undefined) return
      if (settings()?.alerts?.kinds?.error?.enabled === false) return
      const failure = tracker.noteError(sessionId, { error: input.error, stage: input.stage })
      const facts = tracker.factsOf(sessionId)
      if (facts !== undefined) facts.lastError = failure
      const fingerprint = errorFingerprint(sessionId, failure.message, input.stage ?? 'turn')
      if (engine.guard.isCoolingDown(fingerprint)) return
      fire({
        kind: 'error',
        title: `Error: ${truncate(titleOf(sessionId) ?? 'agent run')}`,
        body: failure.message,
        hint: input.stage === 'session'
          ? 'The session failed outside a turn; inspect the session log.'
          : 'Open the session to see the failure and retry the step.',
        sessionId,
        sessionTitle: titleOf(sessionId),
        cwd: cwdOf(sessionId),
        turn: input.turn,
        urgency: 'error',
        fingerprint,
      })
    },

    /**
     * `subagent/end`: a published child settled.
     *
     * @param {object} input - subagent input
     * @param {string} input.sessionId - the child session id
     * @param {any} input.info - the run-end info
     * @returns {void}
     */
    subagentEnd(input) {
      const config = settings()
      if (config?.alerts?.kinds?.subagent?.enabled !== true) return
      const child = input.sessionId
      const output = contentToString(input.info?.lastAssistantMessage)
      fire({
        kind: 'subagent',
        title: `Subagent finished: ${truncate(titleOf(child) ?? child)}`,
        body: [truncate(output, 400) || `stop reason: ${sanitizeLine(input.info?.stopReason ?? 'unknown')}`, '', context()].join('\n'),
        sessionId: child,
        sessionTitle: titleOf(child),
        urgency: 'info',
        fingerprint: `subagent:${sanitizeLine(input.info?.runId ?? child)}`,
      })
    },

    /**
     * The question text remembered at `tools/execute` time, when a caller needs it.
     *
     * @param {string} sessionId - owning session
     * @returns {string | undefined} the remembered question
     */
    lastQuestion(sessionId) {
      return questionText.get(sessionId)
    },
  }

  return runtime
}

/**
 * Normalize the runtime shape a tool result can take into the `tool/result`
 * event shape the tracker folds.
 *
 * @param {any} result - a normalized tool execution result
 * @returns {{ message: { content: any }, error?: { name: string } }} the folded shape
 */
function normalizeToolResult(result) {
  const content = result?.content
  const failed = result?.isError === true || result?.ok === false
  return {
    message: { content: content ?? (typeof result?.value === 'string' ? result.value : '') },
    ...failed ? { error: { name: 'tool' } } : {},
  }
}

/**
 * @param {unknown} value - candidate text
 * @param {number} [max] - maximum length
 * @returns {string} a capped single-line string
 */
function truncate(value, max = 90) {
  const text = sanitizeLine(value ?? '')
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`
}

/** @returns {string} the host name, never throwing */
function safeHostname() {
  try {
    return hostname()
  } catch {
    return 'unknown-host'
  }
}

/** @returns {string} the operator name, never throwing */
function safeUser() {
  try {
    return userInfo().username
  } catch {
    return process.env.USER ?? 'unknown'
  }
}

/**
 * Count how many alerts are waiting in the outbox.
 *
 * @param {import('../core/queue.js').Outbox} outbox - the outbox
 * @returns {number} the pending count
 */
export function pendingCount(outbox) {
  return outbox.size
}

/**
 * Render one failure preview for a failed tool call.
 *
 * @param {any} content - tool result content
 * @returns {string} the preview
 */
export function toolFailurePreview(content) {
  return previewToolResult(content, 300)
}
