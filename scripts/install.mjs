#!/usr/bin/env node
/**
 * Install dsh-notify-long into a dsh profile.
 *
 * The plugin has no build step and no runtime dependencies, so installing it is
 * two mechanical steps:
 *
 * 1. link this directory into `<profile>/node_modules/dsh-notify-long`, which is the
 *    anchor the Cordis loader imports bare package names from;
 * 2. insert the plugin row into `<profile>/cordis.patch.yml`, preserving any
 *    patch entries already there.
 *
 * Both steps are idempotent: re-running the script reports "already installed"
 * and changes nothing.
 *
 * Usage:
 *   node scripts/install.mjs [--profile web] [--uninstall] [--dry-run]
 *
 * @module dsh-notify-long/scripts/install
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { addPluginRow, removePluginRow } from '../lib/core/patch.js'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const pluginName = 'dsh-notify-long'

/** @param {string[]} argv - process arguments @returns {Record<string, any>} parsed flags */
function parseArgs(argv) {
  const options = { profile: 'web', uninstall: false, dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--profile' || token === '-p') options.profile = argv[index += 1]
    else if (token === '--uninstall') options.uninstall = true
    else if (token === '--dry-run') options.dryRun = true
    else if (token === '--help' || token === '-h') options.help = true
    else if (token.startsWith('--profile=')) options.profile = token.slice('--profile='.length)
    else throw new Error(`unknown argument: ${token}`)
  }
  return options
}

/** @param {string} name - profile name @returns {string} the profile directory */
function profileDir(name) {
  if (name === '' || name.includes('/') || name === '.' || name === '..') throw new Error(`invalid profile name: ${JSON.stringify(name)}`)
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'profiles', name)
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  console.log(`Usage: node scripts/install.mjs [--profile web] [--uninstall] [--dry-run]

  --profile, -p   dsh profile to install into (default: web)
  --uninstall     remove the row and the node_modules link
  --dry-run       print the planned changes without writing anything`)
  process.exit(0)
}

const profile = profileDir(options.profile)
if (!existsSync(profile)) {
  console.error(`dsh-notify-long: profile directory ${profile} does not exist. Create it first with: dsh --profile ${options.profile} --dump-config`)
  process.exit(1)
}

const link = join(profile, 'node_modules', pluginName)
const patch = join(profile, 'cordis.patch.yml')
const actions = []

if (options.uninstall) {
  if (lstatSync(link, { throwIfNoEntry: false }) !== undefined) actions.push(`remove link ${link}`)
  const current = existsSync(patch) ? readFileSync(patch, 'utf8') : ''
  if (current !== '' && removePluginRow(current, pluginName) !== current) actions.push(`remove the ${pluginName} row from ${patch}`)
  if (!options.dryRun) {
    rmSync(link, { force: true })
    if (current !== '') writeFileSync(patch, removePluginRow(current, pluginName))
  }
} else {
  const linkExists = lstatSync(link, { throwIfNoEntry: false }) !== undefined
  if (!linkExists) actions.push(`link ${repo} → ${link}`)
  const current = existsSync(patch) ? readFileSync(patch, 'utf8') : '[]\n'
  const next = addPluginRow(current, pluginName)
  if (next !== current) actions.push(`add the ${pluginName} row to ${patch}`)
  if (!options.dryRun) {
    mkdirSync(dirname(link), { recursive: true })
    if (!linkExists) symlinkSync(repo, link, 'dir')
    writeFileSync(patch, next)
  }
}

if (actions.length === 0) {
  console.log(`dsh-notify-long is already ${options.uninstall ? 'absent' : 'installed'} in profile "${options.profile}" (${profile})`)
} else {
  for (const action of actions) console.log(`${options.dryRun ? 'would ' : ''}${action}`)
  console.log(options.dryRun ? '\ndry run: nothing was written' : `\nRestart the profile to load the plugin:  dsh --profile ${options.profile}`)
}
