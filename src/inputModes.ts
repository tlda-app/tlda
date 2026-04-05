/**
 * Input mode preferences — per-feature enable/disable toggles.
 * Each mode persists independently in localStorage. Default: off.
 *
 * Modes:
 *   foot     — gamepad pedal cursor control
 *   clicks   — tongue click / lip pop detection (mic)
 *   whistle  — whistle gesture detection (mic)
 *   hiss     — hiss gesture detection (mic)
 *   voice    — speech recognition for voice notes
 */

export type InputMode = 'foot' | 'clicks' | 'whistle' | 'hiss' | 'voice'

const STORAGE_PREFIX = 'tlda-input-'

const state: Record<InputMode, boolean> = {
  foot: localStorage.getItem(`${STORAGE_PREFIX}foot`) === 'true',
  clicks: localStorage.getItem(`${STORAGE_PREFIX}clicks`) === 'true',
  whistle: localStorage.getItem(`${STORAGE_PREFIX}whistle`) === 'true',
  hiss: localStorage.getItem(`${STORAGE_PREFIX}hiss`) === 'true',
  voice: localStorage.getItem(`${STORAGE_PREFIX}voice`) === 'true',
}

const listeners = new Set<() => void>()

export function getInputMode(mode: InputMode): boolean { return state[mode] }

export function setInputMode(mode: InputMode, v: boolean) {
  if (state[mode] === v) return
  state[mode] = v
  localStorage.setItem(`${STORAGE_PREFIX}${mode}`, String(v))
  listeners.forEach(fn => fn())
}

export function toggleInputMode(mode: InputMode) { setInputMode(mode, !state[mode]) }

export function subscribeInputModes(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

// Stable getter refs for useSyncExternalStore (one per mode, avoids re-render churn)
export const getFootEnabled = () => state.foot
export const getClicksEnabled = () => state.clicks
export const getWhistleEnabled = () => state.whistle
export const getHissEnabled = () => state.hiss
export const getVoiceEnabled = () => state.voice
