/**
 * Unit tests for alert rendering: RFC 2047 words, quoted-printable bodies, and
 * MIME framing (including header-injection rejection).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildAlertMessage,
  buildMessage,
  isMailAddress,
  normalizeAddress,
  normalizeRecipients,
} from '../lib/email/mime.js'
import { buildSubject, encodeHeaderWord, encodeQuotedPrintable, escapeHtml, renderHtmlBody, renderTextBody, soundsForKind } from '../lib/core/text.js'

test('normalizeAddress accepts bare and display-name forms and rejects injections', () => {
  assert.equal(normalizeAddress('ops@example.com'), 'ops@example.com')
  assert.equal(normalizeAddress('Ops <ops@example.com>'), 'Ops <ops@example.com>')
  assert.equal(normalizeAddress('Ops\r\nBcc: evil@example.com <ops@example.com>'), 'Ops Bcc: evil@example.com <ops@example.com>')
  assert.equal(normalizeAddress('not-an-address'), undefined)
  assert.equal(normalizeAddress('a@b'), undefined)
  assert.equal(normalizeAddress(''), undefined)
  assert.equal(isMailAddress('a@b.co'), true)
  assert.equal(isMailAddress('a@b'), false)
})

test('normalizeRecipients splits, trims and de-duplicates', () => {
  assert.deepEqual(normalizeRecipients('a@x.com, b@y.com; c@z.com'), ['a@x.com', 'b@y.com', 'c@z.com'])
  assert.deepEqual(normalizeRecipients(['a@x.com', 'a@x.com']), ['a@x.com'])
  assert.deepEqual(normalizeRecipients('garbage'), [])
})

test('encodeHeaderWord leaves ASCII alone and encodes non-ASCII', () => {
  assert.equal(encodeHeaderWord('plain subject'), 'plain subject')
  const encoded = encodeHeaderWord('任务完成 ✅')
  assert.match(encoded, /^=\?UTF-8\?B\?/)
  assert.ok(encoded.length < 200)
  // Decoding each word reproduces the original text.
  const decoded = encoded
    .split(' ')
    .map((word) => Buffer.from(word.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, ''), 'base64').toString('utf8'))
    .join('')
  assert.equal(decoded, '任务完成 ✅')
})

test('encodeHeaderWord never splits a multi-byte character across words', () => {
  const long = '中'.repeat(60)
  const encoded = encodeHeaderWord(long)
  const words = encoded.split(' ')
  assert.ok(words.length > 1)
  for (const word of words) {
    assert.ok(word.length <= 75, `encoded word too long: ${word.length}`)
    const payload = word.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, '')
    assert.equal(Buffer.from(payload, 'base64').toString('utf8').includes('\uFFFD'), false)
  }
  assert.equal(words.map((word) => Buffer.from(word.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, ''), 'base64').toString('utf8')).join(''), long)
})

test('encodeQuotedPrintable escapes non-ASCII, keeps lines short, ends with CRLF', () => {
  const encoded = encodeQuotedPrintable('héllo world\nsecond line')
  assert.match(encoded, /h=C3=A9llo world/)
  assert.ok(encoded.endsWith('\r\n'))
  for (const line of encoded.split('\r\n')) assert.ok(line.length <= 76)
})

test('buildMessage frames a single-part message with the expected headers', () => {
  const message = buildMessage({
    from: 'DSH <bot@example.com>',
    to: ['ops@example.com'],
    subject: 'Finished: nightly build',
    text: 'all good',
    at: 1_700_000_000_000,
    kind: 'completed',
  })
  assert.match(message.raw, /^From: DSH <bot@example\.com>\r\n/m)
  assert.match(message.raw, /^To: ops@example\.com\r\n/m)
  assert.match(message.raw, /^Subject: \[DSH\] task finished - Finished: nightly build\r\n/m)
  assert.match(message.raw, /^Content-Type: text\/plain; charset=UTF-8\r\n/m)
  assert.match(message.raw, /^X-DSH-Kind: completed\r\n/m)
  assert.equal(message.subject, '[DSH] task finished - Finished: nightly build')
  assert.match(message.messageId, /@example\.com>$/)
})

test('buildMessage frames a multipart alternative when HTML is supplied', () => {
  const message = buildMessage({
    from: 'bot@example.com',
    to: ['ops@example.com'],
    subject: 'hi',
    text: 'plain body',
    html: '<p>html body</p>',
    kind: 'question',
  })
  assert.match(message.raw, /^Content-Type: multipart\/alternative; boundary="dsh-notify-/m)
  assert.match(message.raw, /Content-Type: text\/html; charset=UTF-8/)
  assert.match(message.raw, /\r\n--dsh-notify-[0-9a-z-]+--\r\n/)
})

test('buildAlertMessage renders text and HTML and refuses unusable configuration', () => {
  const settings = {
    email: { from: 'DSH <bot@example.com>', to: 'ops@example.com', subjectPrefix: '[DSH]' },
  }
  const event = {
    kind: 'question',
    title: 'Needs your input: which database?',
    body: 'The agent is blocked.',
    sessionId: 'session-1',
    sessionTitle: 'schema migration',
    cwd: '/tmp/project',
    at: 1_700_000_000_000,
    urgency: 'action',
  }
  const message = buildAlertMessage({ event, settings, sessionTitle: 'schema migration' })
  assert.ok(message !== undefined)
  assert.equal(message.to[0], 'ops@example.com')
  assert.match(message.subject, /^\[DSH\] your input is needed/)
  assert.equal(buildAlertMessage({ event, settings: { email: { to: 'ops@example.com' } } }), undefined)
  assert.equal(buildAlertMessage({ event, settings: { email: { from: 'bot@example.com' } } }), undefined)
})

test('renderTextBody and renderHtmlBody include the session facts', () => {
  const input = {
    kind: 'error',
    title: 'Error: build',
    body: 'compile failed',
    detail: 'Traceback: boom',
    sessionId: 's-1',
    sessionTitle: 'nightly',
    cwd: '/repo',
    at: 1_700_000_000_000,
    urgency: 'error',
    hint: 'Open the session.',
  }
  const text = renderTextBody(input)
  assert.match(text, /Error: build/)
  assert.match(text, /Detail:\nTraceback: boom/)
  assert.match(text, /Next: Open the session\./)
  assert.match(text, /Session: nightly/)
  assert.match(text, /Directory: \/repo/)
  const html = renderHtmlBody(input)
  assert.match(html, /<!doctype html>/)
  assert.match(html, /Traceback: boom/)
  assert.match(html, /Open the session\./)
  assert.equal(escapeHtml('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;')
})

test('buildSubject clips long titles and kindLabel is stable', () => {
  const subject = buildSubject({ kind: 'manual', title: 'x'.repeat(500) })
  assert.ok(subject.length <= 180)
  assert.equal(buildSubject({ kind: 'completed', title: '' }), '[DSH] task finished')
  assert.deepEqual(buildSubject({ kind: 'error', title: 'boom', prefix: '[BOT]' }), '[BOT] error - boom')
})

test('soundsForKind offers distinct sounds per outcome', () => {
  assert.deepEqual(soundsForKind('error').slice(0, 2), ['Basso', 'Sosumi'])
  assert.equal(soundsForKind('completed')[0], 'Glass')
  assert.ok(soundsForKind('completed').includes('complete'))
})
