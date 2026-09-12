/**
 * An in-process SMTP server used by the email tests.
 *
 * It implements just enough ESMTP to exercise the client: greeting, EHLO
 * capability advertisement, optional AUTH, envelope handling, and DATA with
 * dot-unstuffing. Tests configure the exact capabilities and rejections they
 * need, so the client's behaviour under real server responses is verified
 * instead of assumed.
 *
 * @module dsh-notify/test/helpers/smtp-server
 */

import { createServer } from 'node:net'

/**
 * @typedef {object} SmtpServerOptions
 * @property {string[]} [auth] - mechanisms to advertise; an empty list advertises none
 * @property {boolean} [requireAuth] - reject MAIL FROM before a successful AUTH
 * @property {string[]} [rejectRecipients] - recipient addresses rejected with 550
 * @property {boolean} [failData] - reject the message body with 554
 * @property {string} [user] - accepted authentication user
 * @property {string} [pass] - accepted authentication password
 */

/**
 * Start the stub server.
 *
 * @param {SmtpServerOptions} [options] - server behaviour
 * @returns {Promise<{ port: number, received: any[], sessions: number, close: () => Promise<void> }>} the running server
 */
export async function startSmtpServer(options = {}) {
  const state = {
    auth: options.auth ?? ['PLAIN'],
    requireAuth: options.requireAuth === true,
    rejectRecipients: options.rejectRecipients ?? [],
    failData: options.failData === true,
    user: options.user ?? 'user@example.com',
    pass: options.pass ?? 'secret',
  }
  /** @type {any[]} */
  const received = []
  const server = createServer((socket) => {
    let buffer = ''
    let inData = false
    let dataLines = []
    let authenticated = false
    let pendingAuth = undefined
    /** @type {any} */
    let current = {}
    const send = (line) => socket.write(`${line}\r\n`)
    send('220 dsh-notify.test ESMTP ready')

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let index
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        if (inData) {
          if (line === '.') {
            inData = false
            current.raw = dataLines.join('\r\n')
            if (state.failData) send('554 5.7.1 message rejected by policy')
            else {
              received.push(current)
              send('250 2.0.0 Ok: queued as TEST')
            }
            dataLines = []
            continue
          }
          dataLines.push(line.startsWith('..') ? line.slice(1) : line)
          continue
        }
        const [verbRaw, ...rest] = line.split(' ')
        const verb = verbRaw.toUpperCase()
        if (verb === 'EHLO') {
          send('250-dsh-notify.test')
          if (state.auth.length > 0) send(`250-AUTH ${state.auth.join(' ')}`)
          send('250 8BITMIME')
          continue
        }
        if (verb === 'HELO') {
          send('250 dsh-notify.test')
          continue
        }
        if (verb === 'AUTH') {
          const mechanism = (rest[0] ?? '').toUpperCase()
          if (mechanism === 'PLAIN') {
            const decoded = Buffer.from(rest[1] ?? '', 'base64').toString('utf8').split('\u0000')
            authenticated = validate(decoded[1], decoded[2])
            send(authenticated ? '235 2.7.0 accepted' : '535 5.7.8 bad credentials')
            continue
          }
          pendingAuth = mechanism
          send('334 ' + Buffer.from('Username:').toString('base64'))
          continue
        }
        if (pendingAuth !== undefined) {
          if (pendingAuth === 'LOGIN') {
            if (current.authUser === undefined) {
              current.authUser = Buffer.from(line, 'base64').toString('utf8')
              send('334 ' + Buffer.from('Password:').toString('base64'))
              continue
            }
            authenticated = validate(current.authUser, Buffer.from(line, 'base64').toString('utf8'))
            pendingAuth = undefined
            send(authenticated ? '235 2.7.0 accepted' : '535 5.7.8 bad credentials')
            continue
          }
        }
        if (verb === 'MAIL') {
          current = { from: line.slice(line.indexOf(':') + 1) }
          if (state.requireAuth && !authenticated) send('530 5.7.0 authentication required')
          else send('250 2.1.0 Ok')
          continue
        }
        if (verb === 'RCPT') {
          const address = line.slice(line.indexOf(':') + 1)
          current.to = [...(current.to ?? []), address]
          if (state.rejectRecipients.includes(address)) send('550 5.1.1 no such user')
          else send('250 2.1.5 Ok')
          continue
        }
        if (verb === 'DATA') {
          inData = true
          send('354 End data with <CR><LF>.<CR><LF>')
          continue
        }
        if (verb === 'QUIT') {
          send('221 2.0.0 Bye')
          socket.end()
          continue
        }
        if (verb === 'RSET' || verb === 'NOOP') {
          send('250 2.0.0 Ok')
          continue
        }
        send('502 5.5.2 command not implemented')
      }
    })
    socket.on('error', () => undefined)
  })

  /**
   * Validate one credential pair.
   *
   * @param {string} user - supplied user
   * @param {string} pass - supplied password
   * @returns {boolean} whether the credentials match the configured pair
   */
  function validate(user, pass) {
    return user === state.user && pass === state.pass
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    received,
    sessions: 0,
    close: () => new Promise((resolve) => {
      server.close(() => resolve())
      server.unref()
    }),
  }
}
