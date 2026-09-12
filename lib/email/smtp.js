/**
 * Minimal, dependency-free SMTP client.
 *
 * The harness ships no mail library, and this plugin deliberately declares no
 * runtime dependencies, so the submission conversation is implemented directly
 * over `node:net` / `node:tls`:
 *
 * - implicit TLS (typically port 465) and STARTTLS upgrade (typically port 587) —
 *   or `587 → 465 → 25` port fallback when the configured port is unreachable;
 * - `AUTH PLAIN`, `AUTH LOGIN`, and `AUTH CRAM-MD5`;
 * - `MAIL FROM` / `RCPT TO` / `DATA` with per-recipient error reporting, so a
 *   partially accepted envelope is visible instead of silently lost;
 * - a hard wall-clock deadline for the whole conversation, after which the
 *   socket is destroyed and an `SMTP_TIMEOUT` result is returned.
 *
 * Every failure is reported as a value, never thrown: alerting must not be able
 * to break an agent turn.
 *
 * @module dsh-notify-long/lib/email/smtp
 */

import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { createHash, createHmac } from 'node:crypto'
import { hostname } from 'node:os'

import { describeError, sanitizeLine } from '../util.js'

/** Default submission ports tried in order when the configured port is unreachable. */
export const FALLBACK_PORTS = Object.freeze({ 587: [465, 25], 465: [587], 25: [587, 465] })

/**
 * @typedef {object} SmtpOptions
 * @property {string} host - SMTP server hostname
 * @property {number} port - SMTP server port
 * @property {'implicit' | 'starttls' | 'plain'} [tls] - transport mode; default: implicit on 465, starttls elsewhere
 * @property {boolean} [requireTls] - refuse to send credentials over a cleartext link
 * @property {string} [user] - authentication user
 * @property {string} [pass] - authentication password
 * @property {string} [from] - envelope sender
 * @property {string[]} to - envelope recipients
 * @property {string} [cc] - not used by SMTP; accepted and ignored
 * @property {string} raw - complete RFC 5322 message
 * @property {string} [heloName] - EHLO name, defaults to the local host name
 * @property {number} [timeoutMs] - whole-conversation deadline
 * @property {boolean} [allowPortFallback] - try sibling submission ports when the configured one fails
 * @property {(options: any) => Promise<any>} [dial] - connection seam for tests
 */

/**
 * @typedef {object} SmtpResult
 * @property {boolean} ok - whether the server accepted the message
 * @property {string} detail - one-line diagnostic
 * @property {string} [code] - failure code (`SMTP_CONNECT`, `SMTP_AUTH`, `SMTP_REJECT`, …)
 * @property {number[]} [accepted] - indices of accepted recipients
 * @property {string} [response] - final server response after the message body
 * @property {string} [port] - the port that actually delivered
 */

/** Hard cap on one SMTP response line, so a hostile or broken peer cannot grow the buffer. */
export const MAX_RESPONSE_BYTES = 65_536

/**
 * Whether to send credentials before TLS is active.
 *
 * @param {SmtpOptions} options - resolved options
 * @param {boolean} secure - whether the link is encrypted
 * @returns {boolean} true when authentication may proceed
 */
export function mayAuthenticate(options, secure) {
  if ((options.user ?? '') === '') return true
  if (secure) return true
  return options.requireTls !== true
}

/** @returns {string} the EHLO name to announce */
export function announceName(options) {
  return sanitizeLine(options.heloName ?? '') || sanitizeLine(hostname()) || 'localhost'
}

/**
 * Resolve the transport mode for one port.
 *
 * @param {SmtpOptions} options - resolved options
 * @param {number} port - the port being attempted
 * @returns {'implicit' | 'starttls' | 'plain'} the mode
 */
export function modeForPort(options, port) {
  if (options.tls === 'implicit' || options.tls === 'starttls' || options.tls === 'plain') return options.tls
  return port === 465 ? 'implicit' : 'starttls'
}

/**
 * Quote one ESMTP argument when it contains characters that need it.
 *
 * @param {string} value - raw argument
 * @returns {string} the argument, quoted when necessary
 */
export function esmtpArg(value) {
  const text = String(value ?? '')
  if (/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.@]+$/.test(text)) return text
  return `<${text.replace(/[<>]/g, '')}>`
}

/**
 * Extract the bare address from a normalized `Display <addr>` value.
 *
 * @param {string} value - normalized address
 * @returns {string} the bare address
 */
export function bareAddress(value) {
  const match = /<([^<>]+)>/.exec(String(value ?? ''))
  return sanitizeLine(match === null ? String(value ?? '') : match[1])
}

/**
 * Render an authentication payload for one mechanism.
 *
 * @param {'PLAIN' | 'LOGIN' | 'CRAM-MD5'} mechanism - SASL mechanism
 * @param {string} user - authentication user
 * @param {string} pass - authentication password
 * @param {string} [challenge] - server challenge, required for CRAM-MD5
 * @returns {string} the payload (base64 for PLAIN/LOGIN, `user digest` for CRAM-MD5)
 */
export function authPayload(mechanism, user, pass, challenge = '') {
  if (mechanism === 'PLAIN') return Buffer.from(`\u0000${user}\u0000${pass}`, 'utf8').toString('base64')
  if (mechanism === 'LOGIN') return Buffer.from(user, 'utf8').toString('base64')
  const digest = createHmac('md5', pass).update(challenge, 'utf8').digest('hex')
  return `${user} ${digest}`
}

/**
 * Choose an authentication mechanism from the server's advertised list.
 *
 * @param {string[]} extensions - advertised ESMTP capabilities
 * @param {boolean} preferPlain - whether PLAIN may be used
 * @returns {'PLAIN' | 'LOGIN' | 'CRAM-MD5' | undefined} the mechanism, or undefined when none is usable
 */
export function pickMechanism(extensions, preferPlain) {
  const offered = new Set(
    extensions
      .filter((entry) => /^AUTH\b/i.test(entry))
      .flatMap((entry) => entry.replace(/^AUTH\s*/i, '').split(/\s+/).map((name) => name.toUpperCase())),
  )
  if (preferPlain && offered.has('PLAIN')) return 'PLAIN'
  if (offered.has('LOGIN')) return 'LOGIN'
  if (offered.has('CRAM-MD5')) return 'CRAM-MD5'
  if (offered.has('PLAIN')) return 'PLAIN'
  return undefined
}

/**
 * Detect whether the server requires TLS before submission.
 *
 * @param {string[]} extensions - advertised ESMTP capabilities
 * @returns {boolean} true when STARTTLS must be used
 */
export function requiresStartTls(extensions) {
  return extensions.some((entry) => /^STARTTLS$/i.test(entry))
}

/**
 * Send one message. Never throws.
 *
 * @param {SmtpOptions} options - resolved submission options
 * @returns {Promise<SmtpResult>} the outcome
 */
export async function sendMail(options) {
  const dial = typeof options.dial === 'function' ? options.dial : dialSocket
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.trunc(options.timeoutMs) : 20_000
  const deadline = Date.now() + timeoutMs
  const ports = [options.port, ...(options.allowPortFallback === false ? [] : (FALLBACK_PORTS[options.port] ?? []))]
  let last = { ok: false, detail: 'no SMTP attempt was made', code: 'SMTP_CONFIG' }
  for (const port of ports) {
    const remaining = deadline - Date.now()
    if (remaining <= 500) {
      last = { ok: false, detail: 'SMTP deadline expired before a port could be attempted', code: 'SMTP_TIMEOUT' }
      break
    }
    const attempt = await submitOnce({ ...options, port, dial, deadline, timeoutMs: remaining })
    if (attempt.ok) return { ...attempt, port: String(port) }
    last = attempt
    // A rejected message or bad credentials will fail identically on another port.
    if (attempt.code !== 'SMTP_CONNECT' && attempt.code !== 'SMTP_TIMEOUT') break
  }
  return last
}

/**
 * Run one complete submission conversation against one port.
 *
 * @param {SmtpOptions & { deadline: number, dial: (options: any) => Promise<any> }} options - attempt options
 * @returns {Promise<SmtpResult>} the attempt outcome
 */
async function submitOnce(options) {
  const mode = modeForPort(options, options.port)
  const dial = typeof options.dial === 'function' ? options.dial : dialSocket
  const conversation = createConversation({ ...options, mode })
  try {
    const connection = await withDeadline(dial({
      host: options.host,
      port: options.port,
      secure: mode === 'implicit',
      timeoutMs: Math.max(1000, options.deadline - Date.now()),
    }), options.deadline)
    return await conversation.run(connection)
  } catch (error) {
    return { ok: false, detail: describeError(error), code: classifyDialError(error) }
  } finally {
    conversation.close()
  }
}

/**
 * Map a connection failure onto a stable result code.
 *
 * @param {unknown} error - thrown value
 * @returns {string} the code
 */
function classifyDialError(error) {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  if (code === 'DSH_DEADLINE') return 'SMTP_TIMEOUT'
  return 'SMTP_CONNECT'
}

/**
 * Open one real socket: plain TCP, or TLS from the first byte for implicit mode.
 * Resolves once the transport is connected (before the SMTP greeting) and
 * rejects with the socket's error so {@link classifyDialError} can label it.
 *
 * @param {{ host: string, port: number, secure: boolean, timeoutMs: number }} spec - connection spec
 * @returns {Promise<any>} the connected socket
 */
export function dialSocket(spec) {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (error, value) => {
      if (settled) return
      settled = true
      if (error !== undefined) reject(error)
      else resolve(value)
    }
    const socket = spec.secure
      ? tlsConnect({ host: spec.host, port: spec.port, servername: spec.host }, () => settle(undefined, socket))
      : netConnect({ host: spec.host, port: spec.port }, () => settle(undefined, socket))
    socket.setTimeout(spec.timeoutMs, () => {
      const error = new Error(`SMTP connection to ${spec.host}:${spec.port} timed out`)
      error.code = 'DSH_DEADLINE'
      socket.destroy()
      settle(error)
    })
    socket.once('error', (error) => settle(error))
  })
}

/**
 * Race one promise against the wall-clock deadline.
 *
 * @template T
 * @param {Promise<T>} promise - the work
 * @param {number} deadline - epoch milliseconds at which to give up
 * @returns {Promise<T>} the result
 */
function withDeadline(promise, deadline) {
  const remaining = deadline - Date.now()
  if (remaining <= 0) {
    const error = new Error('SMTP deadline expired')
    error.code = 'DSH_DEADLINE'
    return Promise.reject(error)
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error('SMTP deadline expired')
      error.code = 'DSH_DEADLINE'
      reject(error)
    }, remaining)
    if (typeof timer.unref === 'function') timer.unref()
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * Build the stateful protocol runner for one connection: line-buffered replies,
 * command/response pairing, and STARTTLS socket replacement.
 *
 * @param {SmtpOptions & { mode: 'implicit' | 'starttls' | 'plain' }} options - attempt options
 * @returns {{ run: (connection: any) => Promise<SmtpResult>, close: () => void }} the runner
 */
function createConversation(options) {
  /** @type {any} */
  let socket
  let buffer = ''
  let secure = options.mode === 'implicit'
  /** @type {((reply: { code: number, lines: string[] }) => void) | undefined} */
  let waiting
  /** @type {((error: Error) => void) | undefined} */
  let failing
  const transcript = []

  const onData = (chunk) => {
    buffer += chunk.toString('utf8')
    if (buffer.length > MAX_RESPONSE_BYTES) {
      buffer = ''
      fail(new Error('SMTP response exceeded the size cap'))
      return
    }
    const reply = takeReply()
    if (reply !== undefined && waiting !== undefined) {
      const resolve = waiting
      waiting = undefined
      failing = undefined
      transcript.push(`< ${reply.code} ${reply.lines.join(' / ')}`)
      resolve(reply)
    }
  }
  const onError = (error) => fail(error)
  const onClose = () => fail(new Error('SMTP connection closed before the conversation finished'))

  /** @param {Error} error - the failure */
  function fail(error) {
    if (failing === undefined) return
    const reject = failing
    waiting = undefined
    failing = undefined
    reject(error)
  }

  /** @returns {{ code: number, lines: string[] } | undefined} a complete reply, when buffered */
  function takeReply() {
    const lines = buffer.split('\r\n')
    const complete = []
    for (let index = 0; index < lines.length - 1; index += 1) {
      const line = lines[index]
      if (!/^\d{3}[ -]/.test(line)) continue
      complete.push(line)
      if (/^\d{3} /.test(line)) {
        buffer = lines.slice(index + 1).join('\r\n')
        const code = Number(line.slice(0, 3))
        return { code, lines: complete.map((entry) => entry.slice(4)) }
      }
    }
    return undefined
  }

  /** @param {any} next - the socket now carrying the conversation */
  function attach(next) {
    socket = next
    if (typeof socket.setTimeout === 'function') socket.setTimeout(0)
    if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true)
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
  }

  /** @param {string} command - the command line @returns {Promise<{ code: number, lines: string[] }>} the reply */
  function command(line) {
    if (socket === undefined) return Promise.reject(new Error('SMTP socket is not connected'))
    transcript.push(`> ${line}`)
    return new Promise((resolve, reject) => {
      waiting = resolve
      failing = reject
      try {
        socket.write(`${line}\r\n`)
      } catch (error) {
        waiting = undefined
        failing = undefined
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** @returns {Promise<{ code: number, lines: string[] }>} the untagged greeting */
  function greeting() {
    return new Promise((resolve, reject) => {
      waiting = resolve
      failing = reject
    })
  }

  /** @param {string} name - EHLO name @returns {Promise<{ code: number, lines: string[] }>} the EHLO reply */
  async function ehlo(name) {
    let reply = await command(`EHLO ${name}`)
    if (reply.code >= 500) reply = await command(`HELO ${name}`)
    return reply
  }

  /** Upgrade the plain connection to TLS. @returns {Promise<void>} */
  async function startTls() {
    const reply = await command('STARTTLS')
    if (reply.code !== 220) throw new Error(`STARTTLS was refused: ${reply.code} ${reply.lines.join(' ')}`)
    const upgraded = await new Promise((resolve, reject) => {
      const plain = socket
      plain.removeListener('data', onData)
      plain.removeListener('error', onError)
      plain.removeListener('close', onClose)
      const secured = tlsConnect({ socket: plain, servername: options.host, rejectUnauthorized: options.verifyCert !== false }, () => resolve(secured))
      secured.once('error', reject)
    })
    buffer = ''
    secure = true
    attach(upgraded)
  }

  /** @param {string[]} extensions - advertised capabilities @returns {Promise<void>} */
  async function authenticate(extensions) {
    if ((options.user ?? '') === '') return
    if (!mayAuthenticate(options, secure)) throw new Error('SMTP: refusing to send credentials over a cleartext link (set requireTls: false to override)')
    const mechanism = pickMechanism(extensions, options.preferPlain !== false)
    if (mechanism === undefined) throw new Error('SMTP: the server advertised no usable AUTH mechanism')
    if (mechanism === 'PLAIN') {
      const reply = await command(`AUTH PLAIN ${authPayload('PLAIN', options.user, options.pass ?? '')}`)
      if (reply.code !== 235) throw new Error(`SMTP authentication failed (${reply.code} ${reply.lines.join(' ')})`)
      return
    }
    if (mechanism === 'LOGIN') {
      const first = await command('AUTH LOGIN')
      if (first.code !== 334) throw new Error(`SMTP AUTH LOGIN was refused (${first.code} ${first.lines.join(' ')})`)
      const user = await command(authPayload('LOGIN', options.user, ''))
      if (user.code !== 334) throw new Error(`SMTP AUTH LOGIN user was refused (${user.code} ${user.lines.join(' ')})`)
      const pass = await command(Buffer.from(options.pass ?? '', 'utf8').toString('base64'))
      if (pass.code !== 235) throw new Error(`SMTP authentication failed (${pass.code} ${pass.lines.join(' ')})`)
      return
    }
    const challenge = await command('AUTH CRAM-MD5')
    if (challenge.code !== 334) throw new Error(`SMTP AUTH CRAM-MD5 was refused (${challenge.code} ${challenge.lines.join(' ')})`)
    const decoded = Buffer.from(challenge.lines.join('').trim(), 'base64').toString('utf8')
    const reply = await command(Buffer.from(authPayload('CRAM-MD5', options.user, options.pass ?? '', decoded), 'utf8').toString('base64'))
    if (reply.code !== 235) throw new Error(`SMTP authentication failed (${reply.code} ${reply.lines.join(' ')})`)
  }

  return {
    close() {
      if (socket === undefined) return
      try {
        socket.removeListener('data', onData)
        socket.removeListener('error', onError)
        socket.removeListener('close', onClose)
        socket.destroy()
      } catch {
        // A destroyed socket needs no further cleanup.
      }
    },
    async run(connection) {
      attach(connection)
      try {
        const hello = await greeting()
        if (hello.code !== 220) return { ok: false, code: 'SMTP_GREET', detail: `SMTP server refused the connection (${hello.code} ${hello.lines.join(' ')})` }
        const name = announceName(options)
        let extensions = (await ehlo(name)).lines
        if (options.mode === 'starttls' || (options.mode === 'plain' && options.requireTls === true && requiresStartTls(extensions))) {
          if (!requiresStartTls(extensions)) {
            if (options.requireTls === true) return { ok: false, code: 'SMTP_TLS', detail: 'SMTP: the server does not advertise STARTTLS but TLS is required' }
          } else {
            await startTls()
            extensions = (await ehlo(name)).lines
          }
        }
        await authenticate(extensions)
        const envelopeFrom = bareAddress(options.from ?? options.user ?? '')
        const mail = await command(`MAIL FROM:${esmtpArg(envelopeFrom)}`)
        if (mail.code !== 250) return { ok: false, code: 'SMTP_REJECT', detail: `SMTP rejected the sender (${mail.code} ${mail.lines.join(' ')})` }
        const accepted = []
        const rejected = []
        for (const [index, recipient] of options.to.entries()) {
          const reply = await command(`RCPT TO:${esmtpArg(bareAddress(recipient))}`)
          if (reply.code === 250 || reply.code === 251) accepted.push(index)
          else rejected.push(`${bareAddress(recipient)} (${reply.code})`)
        }
        if (accepted.length === 0) return { ok: false, code: 'SMTP_REJECT', detail: `SMTP rejected every recipient: ${rejected.join(', ')}`, accepted }
        const data = await command('DATA')
        if (data.code !== 354) return { ok: false, code: 'SMTP_REJECT', detail: `SMTP refused DATA (${data.code} ${data.lines.join(' ')})`, accepted }
        const settled = await dataPhase(options.raw)
        if (settled.code !== 250) return { ok: false, code: 'SMTP_REJECT', detail: `SMTP rejected the message body (${settled.code} ${settled.lines.join(' ')})`, accepted }
        await command('QUIT').catch(() => undefined)
        const partial = rejected.length > 0 ? ` (rejected: ${rejected.join(', ')})` : ''
        return { ok: true, code: 'SMTP_OK', accepted, response: settled.lines.join(' '), detail: `delivered to ${accepted.length} recipient(s)${partial}` }
      } catch (error) {
        return { ok: false, code: 'SMTP_PROTOCOL', detail: describeError(error) }
      }
    },
  }

  /** Send the message body, dot-stuff it, terminate with the DATA terminator, and await the final reply. @param {string} raw - the message @returns {Promise<{code: number, lines: string[]}>} the reply */
  function dataPhase(raw) {
    if (socket === undefined) return Promise.reject(new Error('SMTP socket is not connected'))
    const normalized = raw.replace(/\r?\n/g, '\r\n')
    const stuffed = normalized.replace(/^\./gm, '..')
    return new Promise((resolve, reject) => {
      waiting = resolve
      failing = reject
      try {
        socket.write(`${stuffed}\r\n.\r\n`)
      } catch (error) {
        waiting = undefined
        failing = undefined
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}
