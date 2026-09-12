/**
 * Event normalization: the pure part of "what did the harness just do?".
 *
 * The engine subscribes to harness events and turns each one into a small,
 * plain fact this module understands — a status change, a finished turn, a
 * failed turn, a pending question. Nothing here touches the harness, so every
 * trigger rule is unit-testable.
 *
 * @module dsh-notify/lib/core/detect
 */

import { clip, describeError, normalizeForHash, sanitizeText } from '../util.js'

/** Maximum characters kept from the first user prompt, for titles and digests. */
export const PROMPT_LIMIT = 120
/** Maximum characters kept from an assistant reply preview. */
export const REPLY_LIMIT = 600
/** Maximum sessions whose facts are retained, so a long-lived process stays bounded. */
export const MAX_TRACKED_SESSIONS = 200

/**
 * @typedef {object} SessionFacts
 * @property {string} id - session id
 * @property {string} [title] - human title (session title or first prompt)
 * @property {string} [cwd] - working directory
 * @property {boolean} sawPrompt - a direct human prompt was seen in this turn
 * @property {string} [promptPreview] - the current turn's prompt preview
 * @property {number} [toolCalls] - distinct tool invocations observed in this turn
 * @property {number} [errors] - tool results flagged as errors in this turn
 * @property {string} [reply] - the last assistant text observed
 * @property {number} [lastTurn] - latest turn/end observed
 * @property {'completed' | 'error' | 'other'} [lastTurnReason] - how that turn ended
 */

/**
 * Flatten one tool result into a short text preview.
 *
 * @param {unknown} content - a `tool/result` message content value
 * @param {number} [limit] - maximum characters
 * @returns {string} the preview
 */
export function previewToolResult(content, limit = 600) {
  return clip(sanitizeText(contentToString(content)), limit)
}

/**
 * Render message content (a string, or an array of content blocks) as plain text.
 *
 * @param {unknown} content - `ContentBlock[]`, a string, or a single block
 * @returns {string} the extracted text
 */
export function contentToString(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      const text = contentToString(block)
      if (text !== '') parts.push(text)
    }
    return parts.join('\n').trim()
  }
  if (typeof content === 'object' && content !== null) {
    const record = /** @type {Record<string, unknown>} */ (content)
    if (typeof record.text === 'string') return record.text
    if (typeof record.content === 'string') return record.content
    if (Array.isArray(record.content)) return contentToString(record.content)
    if (typeof record.name === 'string') return `[${record.name}]`
  }
  return ''
}

/**
 * @typedef {object} TrackerFact
 * @property {'status'} kind - fact discriminator
 * @property {string} sessionId - owning session
 * @property {string} status - `running` | `idle`
 * @property {SessionFacts} facts - the session's folded facts
 */

/**
 * Folds the raw event stream into per-session facts and decides what each
 * transition means: the single place that answers "is this session finished,
 * waiting for an answer, or failed?". One turn never alerts twice: a turn that
 * raised a question or an error flag is consumed when its session returns to
 * idle.
 */
export class Tracker {
  /** @param {() => number} [now] - clock injection for tests */
  constructor(now = () => Date.now()) {
    this.now = now
    /** @type {Map<string, SessionFacts>} */
    this.sessions = new Map()
    /** @type {Map<string, { running: boolean, pending?: 'question' | 'approval' | 'error', parent?: string }>} */
    this.agents = new Map()
  }

  /**
   * Register or update one session's identity facts.
   *
   * @param {string} id - session id
   * @param {object} [facts] - identity facts
   * @param {string} [facts.cwd] - working directory
   * @param {string} [facts.title] - human title
   * @param {string} [facts.parent] - parent session id, marking a subagent child
   * @returns {SessionFacts} the stored facts
   */
  noteSession(id, facts = {}) {
    const existing = this.sessions.get(id) ?? { id, sawPrompt: false }
    if (this.sessions.has(id)) this.sessions.delete(id)
    if (facts.cwd !== undefined) existing.cwd = facts.cwd
    if (facts.title !== undefined && facts.title !== '') existing.title = facts.title
    if (facts.parent !== undefined) existing.parent = facts.parent
    this.sessions.set(id, existing)
    if (this.sessions.size > MAX_TRACKED_SESSIONS) {
      // Drop the least recently touched sessions (Map preserves insertion
      // order, and every note reinserts its entry to the end).
      for (const key of this.sessions.keys()) {
        if (this.sessions.size <= MAX_TRACKED_SESSIONS) break
        if (key !== id) this.sessions.delete(key)
      }
    }
    return existing
  }

  /**
   * @param {string} id - session id
   * @returns {boolean} whether the session is a subagent child
   */
  isSubagent(id) {
    const facts = this.sessions.get(id)
    return facts?.parent !== undefined && facts.parent !== id
  }

  /**
   * Record a direct human prompt (ignoring plugin/context-injected messages).
   *
   * @param {string} sessionId - owning session
   * @param {object} message - the `user/message` event payload
   * @returns {string | undefined} the recorded prompt preview, when this was a real prompt
   */
  noteUserMessage(sessionId, message) {
    const source = message?.source
    if (source?.kind !== 'user') return undefined
    const text = sanitizeText(contentToString(message?.content))
    const facts = this.noteSession(sessionId)
    facts.sawPrompt = true
    facts.promptPreview = clip(text.replace(/\s+/g, ' '), PROMPT_LIMIT)
    if (facts.title === undefined || facts.title === '') facts.title = facts.promptPreview
    return facts.promptPreview
  }

  /**
   * Record a tool invocation or an assistant reply.
   *
   * @param {string} sessionId - owning session
   * @param {string} type - the session event type
   * @param {object} data - the session event payload
   * @returns {void}
   */
  noteSessionEvent(sessionId, type, data) {
    const facts = this.noteSession(sessionId)
    if (type === 'tool/call') {
      facts.toolCalls = (facts.toolCalls ?? 0) + 1
      return
    }
    if (type === 'tool/result') {
      const failed = data?.error !== undefined
        || (Array.isArray(data?.message?.content) && data.message.content.some((block) => block?.isError === true))
      if (failed) {
        facts.errors = (facts.errors ?? 0) + 1
        facts.lastToolError = {
          kind: 'tool',
          message: previewToolResult(data?.message?.content, 400) || 'tool call failed',
          fingerprint: normalizeForHash(`${sessionId}:${previewToolResult(data?.message?.content, 200)}`),
        }
      }
      return
    }
    if (type === 'assistant/message') {
      const text = sanitizeText(contentToString(data?.message?.content))
      if (text !== '') facts.reply = clip(text.replace(/\n{3,}/g, '\n\n'), REPLY_LIMIT)
      return
    }
    if (type === 'step/start') {
      facts.steps = (facts.steps ?? 0) + 1
    }
  }

  /**
   * Mark the session's current turn as needing the operator (question or approval).
   *
   * @param {string} sessionId - owning session
   * @param {'question' | 'approval'} pending - the flag to raise
   * @returns {void}
   */
  notePending(sessionId, pending) {
    const entry = this.agents.get(sessionId) ?? { running: true }
    entry.pending = entry.pending === 'question' ? 'question' : pending
    this.agents.set(sessionId, entry)
  }

  /**
   * Record one failed turn.
   *
   * @param {string} sessionId - owning session
   * @param {object} input - failure detail
   * @param {unknown} [input.error] - the thrown value or `LlmFailure`
   * @param {string} [input.stage] - `turn` | `step` | `session`
   * @returns {{ message: string, fingerprint: string }} the normalized failure
   */
  noteError(sessionId, input) {
    const failure = input.error
    const message = typeof failure === 'object' && failure !== null && 'message' in failure && typeof failure.message === 'string'
      ? failure.message
      : describeError(failure)
    const code = typeof failure === 'object' && failure !== null && 'code' in failure && typeof failure.code === 'string' ? failure.code : ''
    const facts = this.noteSession(sessionId)
    facts.errors = (facts.errors ?? 0) + 1
    const entry = this.agents.get(sessionId) ?? { running: true }
    if (entry.pending === undefined) entry.pending = 'error'
    this.agents.set(sessionId, entry)
    return {
      message: clip(`${message}${code === '' ? '' : ` (${code})`}`, 500),
      fingerprint: normalizeForHash(`${input.stage ?? 'turn'}:${code}:${message}`),
    }
  }

  /**
   * Record a finished turn and report whether it is worth an alert.
   *
   * A turn that never entered a step ran no work (empty input, immediate
   * cancellation), so it is skipped rather than announced.
   *
   * @param {string} sessionId - owning session
   * @param {number} turn - the turn number
   * @param {object} reason - the `TurnEndReason` value
   * @returns {{ notify: boolean, failed: boolean, aborted: boolean, message?: string }} the assessment
   */
  noteTurnEnd(sessionId, turn, reason) {
    const facts = this.noteSession(sessionId)
    const kind = typeof reason?.kind === 'string' ? reason.kind : 'completed'
    facts.lastTurn = turn
    facts.lastTurnReason = kind === 'completed' ? 'completed' : kind === 'error' ? 'error' : 'other'
    const steps = facts.steps ?? 0
    const entry = this.agents.get(sessionId)
    if (entry !== undefined) entry.turnOpen = false
    const aborted = kind === 'aborted' || kind === 'interrupted' || kind === 'disposed'
    if (kind === 'error') {
      // The reason itself carries only structured failure facts; the pending
      // flag raised by the engine's error observer supplies the message.
      return { notify: entry?.pending === 'error' || steps > 0, failed: true, aborted: false }
    }
    if (aborted) return { notify: steps > 0, failed: false, aborted: true }
    const meaningful = steps > 0 || (facts.toolCalls ?? 0) > 0 || (facts.reply ?? '') !== ''
    if (!meaningful && entry?.pending === undefined) return { notify: false, failed: false, aborted: false }
    const message = facts.reply === undefined ? undefined : clip(facts.reply, REPLY_LIMIT)
    return { notify: true, failed: false, aborted: false, ...message === undefined ? {} : { message } }
  }

  /**
   * Start a turn, clearing the per-turn counters.
   *
   * @param {string} sessionId - owning session
   * @returns {void}
   */
  noteTurnStart(sessionId) {
    const facts = this.noteSession(sessionId)
    facts.sawPrompt = facts.sawPrompt === true
    facts.toolCalls = 0
    facts.errors = 0
    facts.steps = 0
    delete facts.reply
    const entry = this.agents.get(sessionId) ?? { running: true }
    entry.turnOpen = true
    this.agents.set(sessionId, entry)
  }

  /**
   * Apply an agent status change and report what it means.
   *
   * @param {string} sessionId - owning session
   * @param {string} status - `running` | `idle`
   * @returns {{ becameIdle: boolean, pending?: 'question' | 'approval' | 'error', facts: SessionFacts }} the transition
   */
  noteStatus(sessionId, status) {
    const entry = this.agents.get(sessionId) ?? { running: false }
    const wasRunning = entry.running === true
    entry.running = status === 'running'
    this.agents.set(sessionId, entry)
    const facts = this.noteSession(sessionId)
    if (status === 'running') {
      // A new turn clears a stale pending flag; a fresh question re-raises it.
      delete entry.pending
      return { becameIdle: false, facts }
    }
    if (!wasRunning) return { becameIdle: false, facts }
    // The flag is deliberately left in place: the engine reads it at dispatch
    // time (see consumePending), which is strictly later than this transition.
    return { becameIdle: true, ...entry.pending === undefined ? {} : { pending: entry.pending }, facts }
  }

  /**
   * Report a status for a session that has no live agent record (a resumed or
   * cold session), so the engine can still alert on the transition.
   *
   * @param {string} sessionId - owning session
   * @param {string} status - `running` | `idle`
   * @returns {void}
   */
  seedStatus(sessionId, status) {
    const entry = this.agents.get(sessionId) ?? { running: false }
    entry.running = status === 'running'
    this.agents.set(sessionId, entry)
  }

  /**
   * Whether the session currently has an open turn.
   *
   * @param {string} sessionId - owning session
   * @returns {boolean} true while a turn is open
   */
  isTurnOpen(sessionId) {
    return this.agents.get(sessionId)?.turnOpen === true
  }

  /** @param {string} sessionId - owning session @returns {SessionFacts | undefined} the folded facts */
  factsOf(sessionId) {
    return this.sessions.get(sessionId)
  }

  /** Forget every folded fact, e.g. when the composition reloads. */
  reset() {
    this.sessions.clear()
    this.agents.clear()
  }
}

/**
 * Compose the title of a completion alert.
 *
 * @param {SessionFacts} facts - the folded session facts
 * @param {string} [sessionTitle] - authoritative session title, when known
 * @returns {string} the alert title
 */
export function completionTitle(facts, sessionTitle) {
  const title = (sessionTitle ?? facts.title ?? '').trim()
  if (title === '') return 'Task finished'
  return `Finished: ${clip(title, 90)}`
}

/**
 * Compose the body of a completion alert.
 *
 * @param {SessionFacts} facts - the folded session facts
 * @param {number} [turn] - the finished turn
 * @returns {string} the alert body
 */
export function completionBody(facts, turn) {
  const lines = []
  if (facts.reply !== undefined && facts.reply !== '') lines.push(clip(facts.reply, REPLY_LIMIT))
  const stats = []
  if (facts.toolCalls !== undefined && facts.toolCalls > 0) stats.push(`${facts.toolCalls} tool call(s)`)
  if (facts.errors !== undefined && facts.errors > 0) stats.push(`${facts.errors} failed tool call(s)`)
  if (turn !== undefined) stats.push(`turn ${turn}`)
  if (stats.length > 0) lines.push(`(${stats.join(', ')})`)
  return lines.join('\n\n')
}
