/**
 * User preferences — configurable defaults for things that have no other UI.
 *
 * NOT for settings that already have direct-manipulation controls
 * (zone width slider, warm mode button, layout toggles, etc.)
 *
 * Backed by server-side fleet_prefs table (per fleet user ID).
 * Local cache makes getPref() synchronous; loadPrefs() populates it async.
 */

import type { CurveHandles } from './curveEditor'
import { DEFAULT_CURVE } from './curveEditor'

const DEFAULTS = {
  'docview-sources': ['ref'] as string[],
  'voice-note-color': 'yellow' as string,
  'math-note-color': 'light-blue' as string,
  'response-curve': DEFAULT_CURVE as CurveHandles,
  'spawn-mode': '' as string,
  'voice-backend': 'chrome' as string,
}

export type PrefKey = keyof typeof DEFAULTS

const _cache: Partial<typeof DEFAULTS> = {}
const _listeners = new Set<() => void>()
let _userId: string | null = null

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
}

export { DEFAULTS }
