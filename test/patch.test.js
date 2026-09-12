/**
 * Tests for the profile patch-document editor used by the installer.
 *
 * The regression that motivated these tests: a row id of `dsh-notify-long`
 * must not be matched by a prefix rule written for `dsh-notify`, and removing
 * one plugin's row must leave every other patch in the document intact.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { addPluginRow, isPluginRow, removePluginRow } from '../lib/core/patch.js'

const NAME = 'dsh-notify-long'

test('isPluginRow compares the id exactly, not by prefix', () => {
  assert.equal(isPluginRow('    - id: dsh-notify-long', NAME), true)
  assert.equal(isPluginRow('    - id: dsh-notify-long  ', NAME), true)
  assert.equal(isPluginRow('    - id: dsh-notify', NAME), false)
  assert.equal(isPluginRow('    - id: dsh-notify-long-extra', NAME), false)
  assert.equal(isPluginRow('    - id: dsh-notify-longer', NAME), false)
  assert.equal(isPluginRow(undefined, NAME), false)
  assert.equal(isPluginRow('      name: dsh-notify-long', NAME), false)
})

test('addPluginRow appends one row and is idempotent', () => {
  const empty = '[]\n'
  const once = addPluginRow(empty, NAME)
  assert.match(once, /- insert:\n {4}- id: dsh-notify-long\n {6}name: dsh-notify-long\n/)
  assert.equal(addPluginRow(once, NAME), once, 'a second install changes nothing')

  // A row whose id merely starts with the name does not count as installed.
  const other = '- insert:\n    - id: dsh-notify-long-extra\n'
  const added = addPluginRow(other, NAME)
  assert.equal(added.includes('id: dsh-notify-long\n      name'), true)
  assert.match(added, /id: dsh-notify-long-extra/)
})

test('addPluginRow preserves an operator patch layer', () => {
  const document = [
    '# my own patch layer',
    '- id: tool-bash',
    '  disabled: true',
    '- insert:',
    '    - id: my-own-row',
    '      name: ./local/plugin.mjs',
    '',
  ].join('\n')
  const next = addPluginRow(document, NAME)
  assert.match(next, /- id: tool-bash\n {2}disabled: true/)
  assert.match(next, /- id: my-own-row/)
  assert.match(next, /- id: dsh-notify-long/)
})

test('removePluginRow removes its own row, comments and inserted block only', () => {
  const document = [
    '# top of file',
    '- id: tool-bash',
    '  disabled: true',
    '',
    '# dsh-notify-long: alerts',
    '# credentials come from the environment',
    '- insert:',
    '    - id: dsh-notify-long',
    '      name: dsh-notify-long',
    '      config:',
    '        enabled: true',
    '',
    '# keep me',
    '- insert:',
    '    - id: other-plugin',
    '      name: other-plugin',
    '',
  ].join('\n')
  const next = removePluginRow(document, NAME)
  assert.equal(next.includes('dsh-notify-long'), false)
  assert.match(next, /- id: tool-bash\n {2}disabled: true/)
  // The line immediately after the removed block must survive: it is the one a
  // stray `index += 1` eats when the skip index is off by one.
  assert.match(next, /\n# keep me\n- insert:\n {4}- id: other-plugin\n {6}name: other-plugin/)
  assert.equal(next.includes('alerts'), false, 'the plugin header block is gone')
  assert.match(next, /# top of file/)

  // Removing twice is a no-op.
  assert.equal(removePluginRow(next, NAME), next)
})

test('removePluginRow leaves a differently-named row that shares the prefix', () => {
  const document = [
    '- insert:',
    '    - id: dsh-notify-long-extra',
    '      name: dsh-notify-long-extra',
    '',
  ].join('\n')
  assert.equal(removePluginRow(document, NAME), document)
  assert.equal(removePluginRow(document, 'dsh-notify-long-extra').trim(), '')
})

test('removePluginRow handles a row inserted into a group', () => {
  const document = [
    '- id: some-group',
    '  name: cordis:group',
    '  group: true',
    '  config:',
    '    - id: inner',
    '      name: inner-plugin',
    '- insert:',
    '    - id: dsh-notify-long',
    '      name: dsh-notify-long',
    '',
  ].join('\n')
  const next = removePluginRow(document, NAME)
  assert.match(next, /- id: some-group\n {2}name: cordis:group/)
  assert.match(next, /- id: inner/)
  assert.equal(next.includes('dsh-notify-long'), false)
})

test('install then uninstall leaves no trace of the plugin', () => {
  for (const original of ['[]\n', '# my layer\n- id: tool-bash\n  disabled: true\n', '[]']) {
    const installed = addPluginRow(original, NAME)
    const removed = removePluginRow(installed, NAME)
    // The generated header names the plugin on every line, so attribution is
    // reliable: nothing mentioning it may survive, and the original content
    // (other than blank-line normalization) must.
    assert.equal(removed.includes(NAME), false)
    assert.equal(removed.includes('insert:'), false)
    for (const line of original.split('\n')) {
      if (line.trim() === '' || line.trim() === '[]') continue
      assert.ok(removed.includes(line), `lost the original line: ${line}`)
    }
  }
})
