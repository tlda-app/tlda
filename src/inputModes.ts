/**
 * DEAD MODULE — zero importers anywhere in the repo. Safe to delete.
 *
 * Superseded by the `voice-backend` preference (`src/preferences.ts`), which is how
 * voice is actually selected: explicit opt-in, one named backend, no on/off boolean.
 * This module is the mechanism that replaced — the doc comment below describes a
 * design that is no longer true ("voice is the only input mode", "it's on or off").
 *
 * It survived only because nobody knew it was here. Deleting it is a five-minute job
 * and nothing will notice. Verified 2026-07-25 during the voice-reconnect diagnosis;
 * see docs/voice-path-known-defects.md.
 *
 * Note it still reads/writes its own `tlda-input-voice` localStorage key, so if
 * anything ever does import it, it will silently disagree with the real preference.
 *
 * ---
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
