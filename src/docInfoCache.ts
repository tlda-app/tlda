/**
 * Module-level cache for per-document JSON assets that are stable within a build:
 *   - proof-info.json  (label regions + proof pairs, ~99KB)
 *   - theorem-map.json (theorem label → display text, ~15KB)
 *
 * Multiple shapes on the same canvas would otherwise each issue an independent
 * fetch with ?t=Date.now() (bypassing the browser cache), repeating 99KB × N
 * on every page load. This module serializes them into a single Promise per
 * projectName and returns the same Promise to all callers.
 *
 * Cache is cleared on signal:reload so a LaTeX rebuild picks up new data.
 */

import { onReloadSignal } from './useYjsSync'
import { STORE_HTTP } from './activeConfig'

const _proofInfoCache = new Map<string, Promise<any>>()
const _theoremMapCache = new Map<string, Promise<any>>()

onReloadSignal(() => {
  _proofInfoCache.clear()
  _theoremMapCache.clear()
})

function assetBase(): string {
  return STORE_HTTP + '/'
}

export function fetchProofInfo(projectName: string): Promise<any> {
  if (!_proofInfoCache.has(projectName)) {
    const base = assetBase()
    _proofInfoCache.set(
      projectName,
      fetch(`${base}docs/${projectName}/proof-info.json`)
        .then(r => r.ok ? r.json() : null)
        .catch(() => null)
    )
  }
  return _proofInfoCache.get(projectName)!
}

export function fetchTheoremMap(projectName: string): Promise<any> {
  if (!_theoremMapCache.has(projectName)) {
    const base = assetBase()
    _theoremMapCache.set(
      projectName,
      fetch(`${base}docs/${projectName}/theorem-map.json`)
        .then(r => r.ok ? r.json() : null)
        .catch(() => null)
    )
  }
  return _theoremMapCache.get(projectName)!
}
