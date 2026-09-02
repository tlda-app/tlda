// The doc-view's time controls: which of the three states they are in, and how
// a recording is named on the shape.
//
// Separate from `docViewPlayback` for one reason: everything here is pure and
// none of it needs tldraw, but `docViewPlayback` imports `createTLStore` and
// `fleet-utils`, and that import graph cannot be loaded outside a browser. Next
// to it, the classroom default below could only be asserted by reading the
// source. Here it can be exercised.

import { isClassroomSurface } from '../classroom/classroomSurface'

/** Where the transport sits: gone, revealed on hover, or always on screen. */
export type TimeControlsMode = 'off' | 'auto-hide' | 'pinned'

const TIME_CONTROLS_MODES: TimeControlsMode[] = ['off', 'auto-hide', 'pinned']

/**
 * The default the shape starts at when nobody has chosen.
 *
 * This is where `RecordingsButton`'s classroom gate went. That gate decided
 * whether playback existed at all, which is why a doc-view outside a classroom
 * could not reach a recording by any route. Here it decides only whether the
 * transport is *showing*: the body is spacetime-capable everywhere, and setting
 * this to `auto-hide` or `pinned` on any doc-view gets you the controls.
 */
export function defaultTimeControlsMode(): TimeControlsMode {
  return isClassroomSurface() ? 'pinned' : 'off'
}

export function timeControlsMode(stored: string | undefined): TimeControlsMode {
  return TIME_CONTROLS_MODES.includes(stored as TimeControlsMode)
    ? (stored as TimeControlsMode)
    : defaultTimeControlsMode()
}

export function formatTimecode(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** A recording id as stored on the shape carries the draft flag in a prefix. */
export function parseRecordingRef(ref: string | undefined): { id: string; privateDraft: boolean } | null {
  if (!ref) return null
  return ref.startsWith('draft:')
    ? { id: ref.slice(6), privateDraft: true }
    : { id: ref, privateDraft: false }
}

export function recordingRef(id: string, privateDraft: boolean | undefined): string {
  return privateDraft ? `draft:${id}` : id
}
