/**
 * Vim mode preference for math note editing.
 * Stored per-browser in localStorage. Default: off.
 */

let enabled = localStorage.getItem('tlda-vim-mode') === 'true'
const listeners = new Set<() => void>()

export function getVimMode(): boolean { return enabled }

export function setVimMode(v: boolean) {
  if (v === enabled) return
  enabled = v
  localStorage.setItem('tlda-vim-mode', String(v))
  listeners.forEach(fn => fn())
}

export function toggleVimMode() { setVimMode(!enabled) }

export function subscribeVimMode(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
