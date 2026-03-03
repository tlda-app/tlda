/**
 * Annotation visibility state: three-mode visibility for foreign annotations
 * + draft shape tracking for local-only annotations.
 *
 * Modes:
 *   'visible' — all annotations shown normally (default)
 *   'faint'   — foreign annotations at ~7% opacity
 *   'hidden'  — foreign annotations invisible (badge only)
 *
 * Draft shapes are created via mergeRemoteChanges() so they never sync.
 * They live in a local Set and get published (re-created as synced) on demand.
 */
import type { TLShapeId } from 'tldraw'

export type VisibilityMode = 'visible' | 'faint' | 'hidden'

// --- Visibility mode ---

const STORAGE_KEY = 'tlda-annotation-visibility'

let mode: VisibilityMode =
  (localStorage.getItem(STORAGE_KEY) as VisibilityMode) || 'visible'

const modeListeners = new Set<() => void>()

export function getVisibilityMode(): VisibilityMode { return mode }

export function setVisibilityMode(m: VisibilityMode) {
  if (m === mode) return
  mode = m
  localStorage.setItem(STORAGE_KEY, m)
  modeListeners.forEach(fn => fn())
}

export function cycleVisibilityMode() {
  setVisibilityMode(
    mode === 'visible' ? 'faint' : mode === 'faint' ? 'hidden' : 'visible'
  )
}

export function subscribeVisibility(fn: () => void): () => void {
  modeListeners.add(fn)
  return () => { modeListeners.delete(fn) }
}

// --- Draft shape tracking ---

const draftIds = new Set<TLShapeId>()
const draftListeners = new Set<() => void>()

export function addDraft(id: TLShapeId) {
  draftIds.add(id)
  draftListeners.forEach(fn => fn())
}

export function removeDraft(id: TLShapeId) {
  draftIds.delete(id)
  draftListeners.forEach(fn => fn())
}

export function isDraft(id: TLShapeId): boolean {
  return draftIds.has(id)
}

export function getDraftCount(): number {
  return draftIds.size
}

export function getDraftIds(): TLShapeId[] {
  return [...draftIds]
}

export function subscribeDrafts(fn: () => void): () => void {
  draftListeners.add(fn)
  return () => { draftListeners.delete(fn) }
}

// --- Draft mode (new annotations become drafts) ---
// Defaults to !canPresent() on connect: r tokens start in draft mode, rw do not.

let draftMode = false
const draftModeListeners = new Set<() => void>()

export function isDraftMode(): boolean { return draftMode }

export function setDraftMode(v: boolean) {
  if (v === draftMode) return
  draftMode = v
  draftModeListeners.forEach(fn => fn())
}

export function toggleDraftMode() { setDraftMode(!draftMode) }

export function subscribeDraftMode(fn: () => void): () => void {
  draftModeListeners.add(fn)
  return () => { draftModeListeners.delete(fn) }
}

// --- Draft hover state (pill hover → preview drafts at full opacity) ---

let draftHovering = false
const hoverListeners = new Set<() => void>()

export function setDraftHovering(v: boolean) {
  if (v === draftHovering) return
  draftHovering = v
  hoverListeners.forEach(fn => fn())
}

export function getDraftHovering(): boolean { return draftHovering }

export function subscribeDraftHovering(fn: () => void): () => void {
  hoverListeners.add(fn)
  return () => { hoverListeners.delete(fn) }
}

// --- Publishing guard ---
// When true, the afterCreateHandler skips draft conversion
let publishing = false
export function isPublishing(): boolean { return publishing }

// --- Publish / discard ---

import type { Editor } from 'tldraw'

/**
 * Publish a draft shape: clear the draft flag so it becomes visible to all.
 * The shape already exists on the server (synced normally); we just flip meta.draft.
 */
export function publishDraft(editor: Editor, shapeId: TLShapeId) {
  const shape = editor.store.get(shapeId)
  if (!shape) { removeDraft(shapeId); return }
  editor.store.update(shapeId, (s: any) => ({
    ...s,
    meta: { ...s.meta, draft: false },
  }))
  removeDraft(shapeId)
}

/**
 * Publish all draft shapes.
 */
export function publishAllDrafts(editor: Editor) {
  const ids = getDraftIds()
  for (const id of ids) {
    publishDraft(editor, id)
  }
}

/**
 * Publish specific draft shapes by ID.
 */
export function publishDrafts(editor: Editor, ids: TLShapeId[]) {
  for (const id of ids) {
    if (isDraft(id)) publishDraft(editor, id)
  }
}

/**
 * Discard a draft shape (delete without publishing).
 */
export function discardDraft(editor: Editor, shapeId: TLShapeId) {
  editor.store.remove([shapeId])
  removeDraft(shapeId)
}
