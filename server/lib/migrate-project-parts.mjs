// `25825e519` moved the parts root from `sourceDir(name)` to `projectDir(name)`,
// because publishing renames `source/` aside and swaps in a copy materialized from
// the revision — which never contains server-written `parts/` or `.tlda/`, so every
// build silently took them. Rooting them beside `source/` rather than inside it is
// the fix, and it is correct for every part written after it.
//
// It moved the root and left the parts. Five projects on the live box still held
// theirs under `source/`, where nothing looks any more: a part that survived the
// swap became unreachable at the moment the fix deployed, and its column vanished
// from the document with no error anywhere — `addMarkdownColumn` returns on ENOENT.
// The one that was noticed was noticed because Skip was looking straight at it.
//
// So this carries them across, at startup, for every project. It is a rename and a
// manifest merge: no part is read, rewritten, or reformatted, and nothing is
// deleted — the emptied `source/parts` and `source/.tlda` directories are left
// where they are rather than removed.
//
// Idempotent by construction: it moves a file only when the destination does not
// exist, so a second run finds nothing to move and a run interrupted halfway
// converges on the next boot. A part already at the new root always wins, since it
// is the newer one by definition.

import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'fs'
import { join } from 'path'
import { readProjectPartsManifest, upsertProjectPartsManifest } from './project-parts-scanner.mjs'

const PARTS_DIR = 'parts'
const TLDA_DIR = '.tlda'

/**
 * Move one directory's entries into another, without overwriting.
 * @returns {number} how many entries moved
 */
function moveEntries(fromDir, toDir) {
  if (!existsSync(fromDir)) return 0
  let moved = 0
  mkdirSync(toDir, { recursive: true })
  for (const entry of readdirSync(fromDir)) {
    const from = join(fromDir, entry)
    const to = join(toDir, entry)
    if (existsSync(to)) continue
    renameSync(from, to)
    moved++
  }
  return moved
}

/**
 * Carry one project's parts from the old root to the new one.
 *
 * The manifest is merged rather than moved: a project can have parts in both
 * places — one written before the deploy and one after — and the new root's
 * manifest is the one the server reads, so the old entries are folded into it
 * through the same writer the materializer uses.
 *
 * @returns {{ parts: number, manifestEntries: number } | null} null when there was nothing to do
 */
export function migrateProjectParts(projectDirPath) {
  const oldRoot = join(projectDirPath, 'source')
  const oldParts = join(oldRoot, PARTS_DIR)
  const oldTlda = join(oldRoot, TLDA_DIR)
  if (!existsSync(oldParts) && !existsSync(oldTlda)) return null

  // The manifest has to be read before `.tlda` moves, because moving it is what
  // would otherwise decide the merge by which file landed first.
  const carried = existsSync(oldTlda) ? readProjectPartsManifest(oldRoot).parts : []

  const parts = moveEntries(oldParts, join(projectDirPath, PARTS_DIR))

  // Everything else under `.tlda` is server state with the same problem, so it
  // travels too — bregman's `.tlda/scratch` is one.
  moveEntries(oldTlda, join(projectDirPath, TLDA_DIR))

  // Re-assert the carried entries against the new root. `upsertProjectPartsManifest`
  // keeps an existing record where the ids collide, which is the right way round:
  // a part at the new root was written after the move and is the live one.
  const existingIds = new Set(readProjectPartsManifest(projectDirPath).parts.map(part => part.id))
  const missing = carried.filter(part => !existingIds.has(part.id))
  if (missing.length) upsertProjectPartsManifest(projectDirPath, missing)

  return { parts, manifestEntries: missing.length }
}

/**
 * Run the migration across every project directory under `projectsDir`.
 *
 * Takes the directory rather than asking the project store, deliberately: a
 * project whose row is missing or whose store has not initialized still has parts
 * on disk, and the point of this pass is that nothing is left behind.
 */
export function migrateAllProjectParts(projectsDir, { logger = console } = {}) {
  if (!existsSync(projectsDir)) return []
  const migrated = []
  for (const entry of readdirSync(projectsDir)) {
    const dir = join(projectsDir, entry)
    let stats
    try {
      stats = statSync(dir)
    } catch {
      continue
    }
    if (!stats.isDirectory()) continue
    try {
      const result = migrateProjectParts(dir)
      if (result && (result.parts || result.manifestEntries)) {
        migrated.push({ project: entry, ...result })
        logger.log?.(`[parts] carried ${result.parts} part(s) and ${result.manifestEntries} manifest entr(ies) out of source/ for "${entry}"`)
      }
    } catch (error) {
      // A project that cannot be carried across must not stop the server, and
      // must not be silent either: the part is unreachable until someone acts.
      logger.error?.(`[parts] could not carry parts out of source/ for "${entry}": ${error.message}`)
    }
  }
  return migrated
}
