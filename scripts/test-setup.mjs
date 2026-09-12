#!/usr/bin/env node
/**
 * Link the harness peer packages into `test/node_modules` so the boot-level
 * tests can import the real plugin module.
 *
 * Those tests load `src/index.js`, which imports `@deepseek-ai/schemastery` and
 * `@deepseek-ai/dsh-tools` — exactly as the Cordis loader does at runtime. This
 * script finds a local dsh installation and symlinks the two packages; without
 * it the boot tests report as skipped instead of failing.
 *
 * Usage: node scripts/test-setup.mjs [--dsh-node-modules <path>]
 *
 * @module dsh-notify-long/scripts/test-setup
 */

import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** Packages the boot tests import. */
const peers = ['schemastery', 'dsh-tools', 'cordis']

/** @param {string[]} argv - process arguments @returns {string | undefined} an explicit anchor */
function parseAnchor(argv) {
  const index = argv.indexOf('--dsh-node-modules')
  if (index >= 0) return argv[index + 1]
  const inline = argv.find((token) => token.startsWith('--dsh-node-modules='))
  return inline === undefined ? undefined : inline.slice('--dsh-node-modules='.length)
}

/** @returns {string[]} candidate `node_modules` directories that may hold the harness */
function candidates() {
  const explicit = parseAnchor(process.argv.slice(2))
  if (explicit !== undefined) return [resolve(explicit)]
  const found = []
  try {
    const bin = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
    if (bin !== '') found.push(resolve(dirname(bin), '..'))
  } catch {
    // `dsh` is not on PATH; fall through to the known layouts.
  }
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  found.push(join(home, 'profiles', 'node_modules'))
  found.push(join(home, 'profiles', 'web', 'node_modules'))
  return found
}

/** @param {string} anchor - a `node_modules` directory @returns {boolean} whether it holds the harness packages */
function hasHarness(anchor) {
  return existsSync(join(anchor, '@deepseek-ai', 'schemastery')) && existsSync(join(anchor, '@deepseek-ai', 'dsh-tools'))
}

const anchor = candidates().find(hasHarness)
if (anchor === undefined) {
  console.error('dsh-notify-long: could not find a dsh installation to link. Pass --dsh-node-modules <path to a node_modules directory that contains @deepseek-ai>.')
  process.exit(1)
}

const target = join(repo, 'test', 'node_modules', '@deepseek-ai')
mkdirSync(target, { recursive: true })
for (const peer of peers) {
  const source = join(anchor, '@deepseek-ai', peer)
  const link = join(target, peer)
  rmSync(link, { force: true })
  if (!existsSync(source)) continue
  symlinkSync(source, link, 'dir')
  console.log(`linked ${link} → ${source}`)
}
console.log(`\npeer packages linked from ${anchor}; run: node --test test/`)
