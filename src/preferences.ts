/**
 * User preferences — configurable defaults for things that have no other UI.
 *
 * NOT for settings that already have direct-manipulation controls
 * (zone width slider, warm mode button, layout toggles, etc.)
 *
 * Backed by server-side fleet_prefs table (per fleet user ID).
 * Local cache makes getPref() synchronous; loadPrefs() populates it async.
 */

import type { CurveHandles } from './curveEditor.ts'
import { DEFAULT_CURVE } from './curveEditor.ts'

const DEFAULTS = {
  'docview-sources': ['ref'] as string[],
  'voice-note-color': 'yellow' as string,
  'math-note-color': 'light-blue' as string,
  'math-note-opacity': 1.0 as number,
  'response-curve': DEFAULT_CURVE as CurveHandles,
  'spawn-mode': '' as string,
  // Default on, but to the SILENT backend (deepgram) — never chrome. Chrome
  // (the only backend whose earcon can beep) is opt-in only. There is NO
  // fallback: if the selected backend is unreachable, voice goes quiet, it
  // never switches to another backend.
  'voice-backend': 'deepgram' as string,
  'voice-submit-words': 'send, send it, sent' as string,
  'voice-sink-shape-types': 'fleet-agents' as string,
  'fleet-font-size': 11 as number,
  // Default fleet layout sizing (used by createFleetLayout). margin-gap is the
  // distance from each document edge to the near edge of the fleet shapes in
  // that margin; everything else stacks outward from there. Height is a fraction
  // of the raw viewport; the rest are px (HUD renders at z=1, so page == screen
  // px). These only shape how layouts are CREATED — never HUD position (anchor).
  'layout-height-frac': 0.7 as number,
  'layout-rail-width': 375 as number,
  'layout-chat-width': 460 as number,
  'layout-margin-gap': 40 as number,
  'fleet-chrome-opacity': 1.0 as number,
  'fleet-content-opacity': 1.0 as number,
  'fleet-age-fade': true as boolean,
  // Per-tool fold heights for monitoring/tool-call content (lines). 0 = never fold.
  // Communication (messages, images) is never folded and has no pref here.
  'fold-bash-lines': 10 as number,
  'fold-write-lines': 10 as number,
  'fold-md-lines': 0 as number,
  'fold-diff-lines': 0 as number,
  // Highlighter edge-zone (the HighlighterSlider). Toggled from the prefs menu.
  'hl-zone-enabled': true as boolean,
}

export type PrefKey = keyof typeof DEFAULTS

const _cache: Partial<typeof DEFAULTS> = {}
const _listeners = new Set<() => void>()
let _userId: string | null = null

let _loadedResolve: (() => void) | null = null
const _loaded = new Promise<void>(r => { _loadedResolve = r })

/** Resolves after the first loadPrefs() completes (or fails). Callers that
 * read prefs at startup should await this to avoid racing against the
 * async fetch — otherwise getPref() returns DEFAULTS even when the user
 * has a saved value. */
export function whenPrefsLoaded(): Promise<void> { return _loaded }

function _notify() { _listeners.forEach(cb => cb()) }

export function subscribePref(cb: () => void): () => void {
  _listeners.add(cb)
  return () => _listeners.delete(cb)
}

export function getPref<K extends PrefKey>(key: K): (typeof DEFAULTS)[K] {
  return (key in _cache ? _cache[key] : DEFAULTS[key]) as (typeof DEFAULTS)[K]
}

export function setPref<K extends PrefKey>(key: K, value: (typeof DEFAULTS)[K]) {
  _cache[key] = value
  _notify()
  if (_userId) {
    fetch(`/api/fleet/prefs/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: _userId, value }),
    }).catch(e => console.warn('[prefs] save failed:', e.message))
  }
}

export function getAllPrefs(): typeof DEFAULTS {
  return { ...DEFAULTS, ..._cache }
}

/** Fetch all prefs for a user and populate the local cache. Call after login. */
export async function loadPrefs(userId: string): Promise<void> {
  _userId = userId
  try {
    const res = await fetch(`/api/fleet/prefs?user=${encodeURIComponent(userId)}`)
    if (!res.ok) return
    const data = await res.json()
    Object.assign(_cache, data)
    _notify()
  } catch {}
  finally {
    if (_loadedResolve) { _loadedResolve(); _loadedResolve = null }
  }
}

export { DEFAULTS }
