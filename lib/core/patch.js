/**
 * Editing of a profile's `cordis.patch.yml` document.
 *
 * The installer has to add exactly one plugin row and remove exactly that row
 * again, without disturbing patches the operator wrote by hand. Those two
 * operations are pure string transforms, so they live here and are unit-tested
 * — the tempting inline regex (`id: dsh-notify` also matches
 * `id: dsh-notify-long`) is exactly the kind of mistake a test should catch.
 *
 * @module dsh-notify-long/lib/core/patch
 */

/** @param {string} name - plugin row id/name @returns {string} the row text to append */
export function pluginRow(name) {
  return [
    '',
    `# ${name}: system sound, desktop and email alerts when an agent finishes,`,
    `# ${name}: fails, or needs the operator — credentials come from the`,
    `# ${name}: environment (DSH_SMTP_PASSWORD), never from this file.`,
    '- insert:',
    `    - id: ${name}`,
    `      name: ${name}`,
    '      config:',
    '        enabled: true',
    '        alerts:',
    '          channels: [sound, desktop, email]',
    '          kinds:',
    '            subagent: { enabled: false }',
    '',
  ].join('\n')
}

/**
 * Whether one line declares `name` as a row id. The comparison is exact: a
 * prefix match would also accept `id: <name>-something`.
 *
 * @param {string | undefined} line - the candidate line
 * @param {string} name - plugin row id
 * @returns {boolean} true when the line declares exactly this row
 */
export function isPluginRow(line, name) {
  if (line === undefined) return false
  const match = /^\s*-\s*id:\s*(\S+)\s*$/.exec(line)
  return match !== null && match[1] === name
}

/**
 * Advance past the block an `- insert:` list owns.
 *
 * @param {string[]} lines - the patch document's lines
 * @param {number} from - the first line after the row's `id:`
 * @returns {number} the index of the last owned line
 */
function skipInsertedBlock(lines, from) {
  let index = from
  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() !== '' && !/^\s{4,}\S/.test(line) && !/^\s*#/.test(line)) break
    index += 1
  }
  return index - 1
}

/**
 * Append the plugin row to a patch document, unless it is already there.
 *
 * @param {string} existing - the current document
 * @param {string} name - plugin row id/name
 * @returns {string} the document with the row appended
 */
export function addPluginRow(existing, name) {
  const lines = existing.split('\n')
  if (lines.some((line) => isPluginRow(line, name))) return existing
  return `${existing.replace(/\s*$/, '')}\n${pluginRow(name)}`
}

/**
 * Remove the plugin row, the `- insert:` marker that carried it, and the
 * comment block directly above it, leaving every other patch untouched.
 *
 * @param {string} existing - the current document
 * @param {string} name - plugin row id/name
 * @returns {string} the document without the row
 */
export function removePluginRow(existing, name) {
  const lines = existing.split('\n')
  const kept = []
  let pendingComments = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    // Comments directly above the row belong to it; hold them until we know
    // whether what follows is this plugin's row.
    if (/^\s*#/.test(line)) {
      pendingComments.push(line)
      continue
    }
    if (/^\s*-\s*insert:\s*$/.test(line) && isPluginRow(lines[index + 1], name)) {
      // The row's own header is the comment block that names the plugin. A
      // block that never mentions it belongs to the operator (or to the patch
      // below) and must survive the uninstall — so it is flushed to `kept`
      // before the row's own lines are skipped.
      const attributed = pendingComments.some((comment) => comment.includes(name))
      if (!attributed) kept.push(...pendingComments)
      pendingComments = []
      // `continue` still runs the loop's own `index += 1`, so land one line
      // short of the last owned line — otherwise the line right after the
      // inserted block (an operator comment, typically) is skipped too.
      index = skipInsertedBlock(lines, index + 2) - 1
      continue
    }
    kept.push(...pendingComments, line)
    pendingComments = []
  }
  return `${kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '')}\n`
}
