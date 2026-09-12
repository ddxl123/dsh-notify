/**
 * Unit tests for the shared helpers.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { clampInt, clip, deepMerge, describeError, formatClock, hashKey, parseClock, redact, sanitizeLine, sanitizeText } from '../lib/util.js'

test('parseClock accepts HH:MM and rejects anything else', () => {
  assert.equal(parseClock('22:00'), 22 * 60)
  assert.equal(parseClock('7:05'), 7 * 60 + 5)
  assert.equal(parseClock('00:00'), 0)
  assert.equal(parseClock('24:00'), 24 * 60)
  assert.equal(parseClock('24:30'), undefined)
  assert.equal(parseClock('25:00'), undefined)
  assert.equal(parseClock('22:60'), undefined)
  assert.equal(parseClock('10pm'), undefined)
  assert.equal(parseClock(undefined), undefined)
  assert.equal(parseClock(' 22:00 '), 22 * 60)
})

test('formatClock wraps into a 24-hour clock', () => {
  assert.equal(formatClock(0), '00:00')
  assert.equal(formatClock(8 * 60 + 5), '08:05')
  assert.equal(formatClock(1440 + 90), '01:30')
})

test('deepMerge overlays without mutating and keeps lower-precedence leaves', () => {
  const base = { a: 1, nested: { x: 1, y: 2 }, list: [1, 2] }
  const merged = deepMerge(base, { nested: { y: 9 }, list: [3] })
  assert.deepEqual(merged, { a: 1, nested: { x: 1, y: 9 }, list: [3] })
  assert.deepEqual(base, { a: 1, nested: { x: 1, y: 2 }, list: [1, 2] })
  assert.deepEqual(deepMerge(base, { nested: { y: undefined } }), base)
})

test('sanitizeLine strips control characters and collapses whitespace', () => {
  assert.equal(sanitizeLine('hello\r\nworld'), 'hello world')
  assert.equal(sanitizeLine('  spaced   out  '), 'spaced out')
  assert.equal(sanitizeLine(null), '')
})

test('sanitizeText normalizes newlines and trims blank runs', () => {
  assert.equal(sanitizeText('a\r\nb\n\n\n\nc'), 'a\nb\n\nc')
  assert.equal(sanitizeText('  trailing   \n'), 'trailing')
})

test('clip and redact keep output bounded', () => {
  assert.equal(clip('abcdef', 4), 'abc…')
  assert.equal(clip('abc', 4), 'abc')
  assert.equal(clip('abcdef', 0), '')
  assert.equal(redact('supersecretvalue'), 'su********')
  assert.equal(redact(''), '')
})

test('hashKey is stable and input-sensitive', () => {
  assert.equal(hashKey('same'), hashKey('same'))
  assert.notEqual(hashKey('same'), hashKey('other'))
  assert.match(hashKey('x'), /^[0-9a-f]{8}$/)
})

test('clampInt and describeError behave defensively', () => {
  assert.equal(clampInt('7', 1, 0, 5), 5)
  assert.equal(clampInt(undefined, 3, 0, 5), 3)
  assert.equal(describeError(new TypeError('bad')), 'TypeError: bad')
  assert.equal(describeError('plain'), 'plain')
  assert.equal(describeError({ a: 1 }), '{"a":1}')
})
