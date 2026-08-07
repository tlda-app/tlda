// Every path that can delete a fleet pill, and what was true when it did.
//
// Skip: "WHAT ABOUT POPPING PILLS DUDE … IS THERE NO INSTRUMENTATION YOU CAN DO?"
// There wasn't. Pills are deleted from four independent places and none of them
// said so, which makes "it popped" unattributable and left reading the code as
// the only tool — three fixes tonight came out of that and none of them was the
// one he was hitting.
//
// The instrument then claimed a coverage it did not have. On 2026-08-07 the live
// box's 6.1 GB client.log held ZERO records from this module while pills were
// popping under him, because only three deleters called it and none of them was
// on the path a roster drag takes. The four pointer-handler surfaces — roster,
// search, chat, highlighter — each carry their own copy of the same drop/cancel
// pair, and all eight deleted silently. An instrument that is quiet on the busy
// path is worse than none: it reads as "that deleter did not fire".
//
// So deleting a pill and recording it are now ONE call, deleteFleetPill. A new
// delete site cannot be added without an entry in FleetPillDeleter, which is the
// only property that keeps this file true.
//
// This is the always-on subset that matters: one record per deletion, naming the
// path and carrying enough state to tell an intentional removal from a pill
// vanishing under the pointer. It is written with log.metric, which is the sink
// that actually reaches client.log; log.debug is gated at warn and would produce
// an instrument indistinguishable from one that is not running.
//
// Volume is a pill deletion per drag, not a hot path.

// @ts-ignore -- vanilla JS module
import { log } from '../logger'

import { isFleetPillActive } from './fleet-pill-policy'

const NS = 'pill-forensics'

/** Which code path is removing the pill. One per deleter, no catch-all. */
export type FleetPillDeleter =
  /** The 10s staleness reclaim in fleet-pill-reclaimer. */
  | 'stale-reclaim'
  /** The sweep that removes every ACTIVE pill when the window loses focus, the
   *  tab hides, Escape is pressed, or the page is going away. */
  | 'terminate-active'
  /** Ordinary end of a tldraw translate — the pill has done its job. */
  | 'translate-end'
  /** Ordinary end of a pointer-handler drag, after the drop has been applied.
   *  The panel surfaces never start a tldraw translate, so this is what
   *  'translate-end' is for them. Expected, and the common case. */
  | 'drag-drop'
  /** A pointer-handler drag was interrupted rather than completed —
   *  pointercancel, Escape, window blur, or another surface claiming the drag
   *  coordinator. THIS is the one that looks like a pop to him: the pill goes
   *  and no filter is applied. */
  | 'drag-cancel'
  /** The pill crossed between the panel editor and the main editor and is being
   *  recreated in the other one on the same tick. Not a disappearance — but if
   *  the recreate throws, this record is the only trace left. */
  | 'editor-handoff'
  /** The legacy sweep for pills parented to an agents panel. */
  | 'legacy-orphan'

/** Which drag surface owns the pill, for the deleters that have four copies. */
export type FleetPillSurface = 'roster' | 'search' | 'chat' | 'highlighter'

export type FleetPillDeletionContext = {
  /** Which of the terminate-active triggers fired, when that is the deleter. */
  trigger?: 'blur' | 'pagehide' | 'visibility-hidden' | 'escape' | 'dispose'
  /** Which panel started the drag, for drag-drop / drag-cancel / editor-handoff. */
  surface?: FleetPillSurface
  ageMs?: number
  createdAt?: number
  ephemeral?: boolean
  ownerless?: boolean
}

/**
 * Record a pill deletion. Internal to deleteFleetPill, which calls it
 * immediately BEFORE the delete so `active` reflects the state that allowed it
 * rather than the state after cleanup.
 */
function noteFleetPillDeleted(
  pillId: string,
  deleter: FleetPillDeleter,
  context: FleetPillDeletionContext = {},
) {
  // A pill deleted while ACTIVE was deleted out from under a live drag. That is
  // the signature of the reported bug and the field to read first, so every
  // cancel path records BEFORE it clears ACTIVE. The drop paths clear it first
  // by design — a completed drag is over, and 'drag-drop' already says so.
  const active = isFleetPillActive(pillId)
  log.metric(NS, active ? 'pill deleted MID-DRAG' : 'pill deleted', {
    pillId,
    deleter,
    active,
    ...context,
  })
}

/** The part of tldraw's Editor this module needs. Keeps the panel surfaces —
 *  which pass a main editor or a clipped panel editor interchangeably — from
 *  having to agree on a type. */
type FleetPillDeletingEditor = {
  getShape: (id: any) => unknown
  deleteShapes: (ids: any[]) => void
}

/**
 * Delete a fleet pill and record which path did it.
 *
 * Every pill deletion goes through here. Recording is not a line you can forget
 * beside the delete, because it is the same call — and that separation is
 * exactly what left this instrument silent while the bug it was built for was
 * live.
 *
 * No-ops when the pill is already gone, so callers keep their existing
 * "delete if still present" semantics without repeating the guard.
 */
export function deleteFleetPill(
  editor: FleetPillDeletingEditor,
  pillId: unknown,
  deleter: FleetPillDeleter,
  context: FleetPillDeletionContext = {},
) {
  if (!editor?.getShape?.(pillId)) return
  noteFleetPillDeleted(String(pillId), deleter, context)
  editor.deleteShapes([pillId])
}
