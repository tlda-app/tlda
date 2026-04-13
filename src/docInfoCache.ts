/**
 * Module-level cache for per-document JSON assets that are stable within a build:
 *   - proof-info.json  (label regions + proof pairs, ~99KB)
 *   - theorem-map.json (theorem label → display text, ~15KB)
 *
 * Multiple shapes on the same canvas would otherwise each issue an independent
 * fetch with ?t=Date.now() (bypassing the browser cache), repeating 99KB × N
 * on every page load. This module serializes them into a single Promise per
 * docName and returns the same Promise to all callers.
 *
 * Cache is cleared on signal:reload so a LaTeX rebuild picks up new data.
 */

import { onReloadSignal } from './useYjsSync'

const _proofInfoCache = new Map<string, Promise<any>>()
const _theoremMapCache = new Map<string, Promise<any>>()

onReloadSignal(() => {
  _proofInfoCache.clear()
  _theoremMapCache.clear()
})

function assetBase(): string {
  const ws = (import.meta as any).env?.VITE_SYNC_SERVER as string | undefined
  if (ws) return ws.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '') + '/'
  return (import.meta as any).env?.BASE_URL || '/'
}

export function fetchProofInfo(docName: string): Promise<any> {
  if (!_proofInfoCache.has(docName)) {
    const base = assetBase()
    _proofInfoCache.set(
      docName,
      fetch(`${base}docs/${docName}/proof-info.json`)
        .then(r => r.ok ? r.json() : null)
        .catch(() => null)
    )
  }
  return _proofInfoCache.get(docName)!
}

export function fetchTheoremMap(docName: string): Promise<any> {
  if (!_theoremMapCache.has(docName)) {
    const base = assetBase()
    _theoremMapCache.set(
      docName,
      fetch(`${base}docs/${docName}/theorem-map.json`)
        .then(r => r.ok ? r.json() : null)
        .catch(() => null)
    )
  }
  return _theoremMapCache.get(docName)!
}
