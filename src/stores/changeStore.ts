/**
 * Change highlight store (local "unread" state, not synced via Yjs).
 *
 * Supports per-shape subscriptions so only the affected SvgPageComponent
 * re-renders when highlights change, not all 40+ pages.
 */

export interface ChangeRegion {
  y: number       // viewBox y coordinate (top of changed region)
  height: number  // region height in viewBox units
  x?: number      // viewBox x (left edge); omit for full-width
  width?: number  // region width in viewBox units; omit for full-width
  tint?: string   // CSS color for text tinting (e.g. '#4488ff'); omit for default highlight
}

export const changeStore = new Map<string, ChangeRegion[]>()  // shapeId → regions
export const changedPages = new Set<string>()                 // shapeIds with unread changes

// --- Per-shape listeners (targeted notifications) ---
const shapeListeners = new Map<string, Set<() => void>>()

/** Subscribe to changes for a specific shape. Returns unsubscribe function. */
export function onShapeChangeUpdate(shapeId: string, fn: () => void): () => void {
  if (!shapeListeners.has(shapeId)) shapeListeners.set(shapeId, new Set())
  shapeListeners.get(shapeId)!.add(fn)
  return () => {
    const listeners = shapeListeners.get(shapeId)
    if (listeners) {
      listeners.delete(fn)
      if (listeners.size === 0) shapeListeners.delete(shapeId)
    }
  }
}

function notifyShapeListeners(shapeId: string) {
  const listeners = shapeListeners.get(shapeId)
  if (listeners) {
    for (const fn of listeners) fn()
  }
}

function notifyAllShapeListeners() {
  for (const [, listeners] of shapeListeners) {
    for (const fn of listeners) fn()
  }
}

// --- Global listeners (legacy, used by external consumers) ---
type ChangeListener = () => void
const changeListeners = new Set<ChangeListener>()

export function onChangeStoreUpdate(fn: ChangeListener): () => void {
  changeListeners.add(fn)
  return () => { changeListeners.delete(fn) }
}

function notifyGlobalListeners() {
  for (const fn of changeListeners) fn()
}

export function setChangeHighlights(shapeId: string, regions: ChangeRegion[]) {
  if (regions.length > 0) {
    changeStore.set(shapeId, regions)
    changedPages.add(shapeId)
  } else {
    changeStore.delete(shapeId)
    changedPages.delete(shapeId)
  }
  notifyShapeListeners(shapeId)
  notifyGlobalListeners()
}

export function dismissPageChanges(shapeId: string) {
  changeStore.delete(shapeId)
  changedPages.delete(shapeId)
  notifyShapeListeners(shapeId)
  notifyGlobalListeners()
}

export function dismissAllChanges() {
  changeStore.clear()
  changedPages.clear()
  notifyAllShapeListeners()
  notifyGlobalListeners()
}

// Expose change store on window for testing/debugging
import { svgViewBoxStore } from './svgViewBoxStore'
if (typeof window !== 'undefined') {
  (window as any).__changeStore__ = { changeStore, changedPages, setChangeHighlights, dismissAllChanges, dismissPageChanges, svgViewBoxStore }
}
