/**
 * Semantic highlight mode: color-coded highlights (wrong/cite/explain/notation/approve).
 * Stored per-browser in localStorage. Default: off.
 * When off, standard highlight tool works without the color palette.
 */

let enabled = localStorage.getItem('tlda-semantic-highlight') === 'true'
const listeners = new Set<() => void>()

export function getSemanticHighlight(): boolean { return enabled }

export function setSemanticHighlight(v: boolean) {
  if (v === enabled) return
  enabled = v
  localStorage.setItem('tlda-semantic-highlight', String(v))
  listeners.forEach(fn => fn())
}

export function toggleSemanticHighlight() { setSemanticHighlight(!enabled) }

export function subscribeSemanticHighlight(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
