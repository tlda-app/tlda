/**
 * The place stack — forward and back over documents.
 *
 * Skip, 2026-08-11 04:50 EDT:
 *
 * > we maintain a place stack. Right? … there's a place stack can go forward
 * > and back in. Like, a browser has that.
 * > Where a place is a document.
 *
 * So the unit is a DOCUMENT, not a camera position. That is the whole point:
 * the thing you want is to get back out of a Markdown document, and a stack of
 * scroll positions inside it does not do that. `AnnotationViewer` already keeps
 * a camera stack for its own popup; this is a different object with a different
 * unit, and it is deliberately not that one.
 *
 * `Like, a browser has that` settles the semantics we would otherwise have to
 * invent, and this file borrows them rather than deciding again:
 *
 * - going somewhere new pushes where you were, and abandons forward history;
 * - back and forward move through that history without pushing;
 * - returning restores the view you had there, the way a browser restores
 *   scroll position rather than dumping you at the top.
 *
 * The one place the borrowing needs a decision: a browser pushes an in-page
 * anchor jump as its own entry. Here that would fill the stack with hops inside
 * one Markdown document and back would no longer get you out of it — the exact
 * complaint. So consecutive entries for the same document coalesce: the stack
 * holds the LATEST view of each document in a run, and back always lands you in
 * a different document. That follows from `a place is a document` rather than
 * softening it.
 */

import type { Editor, TLPageId } from 'tldraw'
import {
  departFrom,
  emptyPlaceStack,
  stepBack,
  stepForward,
  type Place,
  type PlaceStack,
} from './placeStackCore'
import {
  activateSpatialDocument,
  currentSpatialDocument,
  spatialWorldDocuments,
  type SpatialDocumentNode,
} from './spatialDocumentWorld'

export type { Place } from './placeStackCore'
export type PlaceStackDepth = { back: number; forward: number }

let stack: PlaceStack = emptyPlaceStack
let restoring = false

const listeners = new Set<() => void>()
let depthSnapshot: PlaceStackDepth = { back: 0, forward: 0 }

function emit() {
  const next = { back: stack.back.length, forward: stack.forward.length }
  // useSyncExternalStore compares by reference, so only mint a new object when
  // the numbers actually moved. Otherwise every camera nudge re-renders the ToC.
  if (next.back === depthSnapshot.back && next.forward === depthSnapshot.forward) return
  depthSnapshot = next
  for (const listener of listeners) listener()
}

export function subscribePlaceStack(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function getPlaceStackDepth(): PlaceStackDepth {
  return depthSnapshot
}

function placeHere(editor: Editor): Place | null {
  const document = currentSpatialDocument(editor, spatialWorldDocuments(editor))
  if (!document) return null
  const camera = editor.getCamera()
  return {
    documentId: document.id,
    pageId: String(editor.getCurrentPageId()),
    camera: { x: camera.x, y: camera.y, z: camera.z },
  }
}

/**
 * Record where the reader is, immediately BEFORE a navigation moves them.
 *
 * Called from the go-to-a-document primitives rather than from their callers,
 * so the map, the project list, the viewer and in-page links all get the same
 * behaviour and a new caller cannot forget to. A navigation that does not
 * change document replaces the entry for that document instead of stacking
 * another one.
 */
export function recordPlaceDeparture(editor: Editor) {
  if (restoring) return
  const here = placeHere(editor)
  if (!here) return
  stack = departFrom(stack, here)
  emit()
}

function enter(editor: Editor, place: Place): Place | null {
  const departing = placeHere(editor)
  const documents = spatialWorldDocuments(editor)
  const target = documents.find((node: SpatialDocumentNode) => node.id === place.documentId)
  const camera = editor.getCamera()
  restoring = true
  try {
    if (place.pageId && place.pageId !== String(editor.getCurrentPageId())) {
      editor.setCurrentPage(place.pageId as TLPageId)
    }
    const source = currentSpatialDocument(editor, documents)
    // Carry the reader's panel layout to the destination the same way every
    // other document move does, instead of teleporting the camera underneath it.
    if (source && target && source.id !== target.id) {
      activateSpatialDocument(editor, source, target, camera)
    }
    editor.setCamera(place.camera, { animation: { duration: 300 } })
  } finally {
    restoring = false
  }
  return departing
}

export function goBackPlace(editor: Editor) {
  const target = stack.back[stack.back.length - 1]
  if (!target) return
  const departing = enter(editor, target)
  stack = stepBack(stack, departing).next
  emit()
}

export function goForwardPlace(editor: Editor) {
  const target = stack.forward[stack.forward.length - 1]
  if (!target) return
  const departing = enter(editor, target)
  stack = stepForward(stack, departing).next
  emit()
}

/** Test seam. The stack is per-session and per-device, like a browser's. */
export function resetPlaceStack() {
  stack = emptyPlaceStack
  restoring = false
  depthSnapshot = { back: 0, forward: 0 }
}
