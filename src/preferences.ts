/**
 * User preferences — configurable defaults for things that have no other UI.
 *
 * NOT for settings that already have direct-manipulation controls
 * (zone width slider, warm mode button, layout toggles, etc.)
 */

import type { CurveHandles } from './curveEditor'
import { DEFAULT_CURVE } from './curveEditor'

const DEFAULTS = {
  'docview-sources': ['ref'] as string[],
  'voice-note-color': 'yellow' as string,
  'math-note-color': 'light-blue' as string,
  'response-curve': DEFAULT_CURVE as CurveHandles,
}

export type PrefKey = keyof typeof DEFAULTS

const STORAGE_KEY = 'tlda-preferences'

const _listeners = new Set<() => void>()

export function subscribePref(cb: () => void): () => void {
  _listeners.add(cb)
  return () => _listeners.delete(cb)
}

export function getPref<K extends PrefKey>(key: K): (typeof DEFAULTS)[K] {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    return stored[key] ?? DEFAULTS[key]
  } catch {
    return DEFAULTS[key]
  }
}

export function setPref<K extends PrefKey>(key: K, value: (typeof DEFAULTS)[K]) {
  const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
  stored[key] = value
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
  _listeners.forEach(cb => cb())
}

export function getAllPrefs(): typeof DEFAULTS {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    return { ...DEFAULTS, ...stored }
  } catch {
    return { ...DEFAULTS }
  }
}

export { DEFAULTS }
