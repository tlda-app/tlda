/**
 * doc-assets.mjs — single source of truth for resolving a doc's output assets
 * on disk.
 *
 * Imported by BOTH the server asset route (server/unified-server.mjs) and the
 * MCP disk reader (mcp-server/data-source.mjs). Before this module the two had
 * separate copies of the bare→texBase alias: the server route aliased bare
 * metadata names to the primary target's prefixed file, but data-source did
 * not — so `lookup.json` resolved over HTTP yet returned null in disk mode,
 * and line→page anchoring (`scroll_to_line` / `add_note`) silently failed on
 * single-machine setups. One resolver kills that divergence.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

/**
 * Project-level metadata files that predate multi-target builds. Viewer and
 * MCP code request them by bare name; on disk they carry the primary target's
 * texBase prefix (e.g. `bregman-lower-bound-lookup.json`). This set is the
 * only place that aliasing is declared.
 */
export const BARE_METADATA = new Set([
  'lookup.json', 'macros.json', 'proof-info.json',
  'source-map.json', 'theorem-map.json',
])

/** basename of the project's primary tex target (e.g. 'bregman-lower-bound'), or null. */
export function primaryTexBase(projectsDir, name) {
  try {
    const project = JSON.parse(readFileSync(join(projectsDir, name, 'project.json'), 'utf8'))
    return (project.mainFile || 'main.tex').replace(/\.tex$/, '').split('/').pop()
  } catch {
    return null
  }
}

/**
 * Resolve a logical doc-asset name to its absolute on-disk path under the
 * project's output/ dir. For BARE_METADATA names, falls back to the primary
 * target's prefixed file. Returns the existing path, or null if neither the
 * direct nor the aliased file exists.
 *
 * @param {string} projectsDir absolute path to the server/projects dir
 * @param {string} name        project (doc) name
 * @param {string} logicalName requested asset filename (bare or prefixed)
 */
export function resolveAsset(projectsDir, name, logicalName) {
  const outDir = join(projectsDir, name, 'output')
  const direct = join(outDir, logicalName)
  if (existsSync(direct)) return direct
  if (BARE_METADATA.has(logicalName)) {
    const base = primaryTexBase(projectsDir, name)
    if (base) {
      const aliased = join(outDir, `${base}-${logicalName}`)
      if (existsSync(aliased)) return aliased
    }
  }
  return null
}
