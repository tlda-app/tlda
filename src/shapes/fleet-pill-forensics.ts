// Every path that can delete a fleet pill, and what was true when it did.
//
// Skip: "WHAT ABOUT POPPING PILLS DUDE … IS THERE NO INSTRUMENTATION YOU CAN DO?"
// There wasn't. Pills are deleted from four independent places and none of them
// said so, which makes "it popped" unattributable and left reading the code as
// the only tool — three fixes tonight came out of that and none of them was the
// one he was hitting.
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
  /** The 5s from-creation timer in FleetPillShape.onCreate. Only a tldraw
   *  translate clears it, and chat-dragged pills never start one. */
  | 'create-timer'
  /** The sweep that removes every ACTIVE pill when the window loses focus, the
   *  tab hides, Escape is pressed, or the page is going away. */
  | 'terminate-active'
  /** Ordinary end of a drag — the pill has done its job. */
  | 'translate-end'

export type FleetPillDeletionContext = {
  /** Which of the terminate-active triggers fired, when that is the deleter. */
  trigger?: 'blur' | 'pagehide' | 'visibility-hidden' | 'escape' | 'dispose'
  ageMs?: number
  createdAt?: number
  ephemeral?: boolean
  ownerless?: boolean
}

/**
 * Record a pill deletion. Call this immediately BEFORE the delete, so `active`
 * reflects the state that allowed it rather than the state after cleanup.
 */
export function noteFleetPillDeleted(
  pillId: string,
  deleter: FleetPillDeleter,
  context: FleetPillDeletionContext = {},
) {
  // A pill deleted while ACTIVE was deleted out from under a drag. That is the
  // signature of the reported bug, and it is the field to read first.
  const active = isFleetPillActive(pillId)
  log.metric(NS, active ? 'pill deleted MID-DRAG' : 'pill deleted', {
    pillId,
    deleter,
    active,
    ...context,
  })
}

/**
 * Record that a pill was created and by which surface, so a deletion can be read
 * against how long it survived and what was dragging it.
 */
export function noteFleetPillCreated(pillId: string, source: string) {
  log.metric(NS, 'pill created', { pillId, source })
}
