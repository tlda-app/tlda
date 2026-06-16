/**
 * Input mode preferences.
 *
 * Voice is the only input mode: a single on/off setting. There are no
 * gesture/mic backends to select, no overrides, no fallbacks — it's on or off.
 * Persisted in localStorage.
 */

export type InputMode = 'voice'

const STORAGE_PREFIX = 'tlda-input-'

const state: Record<InputMode, boolean> = {
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

export const getVoiceEnabled = () => state.voice
