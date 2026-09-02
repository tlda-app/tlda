/**
 * docViewPlayback — the parts of playback that are not a component.
 *
 * All of this was inside `RecordingViewer`, which was one floating window that
 * played one recording at a time. A doc-view can show a recording in its body,
 * and there can be several doc-views, so the store construction and the
 * transport clock had to stop being that window's local state. Nothing here is
 * new behaviour; `frozenPlaybackStore` in particular is the same function it
 * was, moved.
 */

import { createTLStore, loadSnapshot } from 'tldraw'
import type { TLAnyShapeUtilConstructor, TLStore, TLShapeId } from 'tldraw'
import type { RecordingMeta, RecordingEvent } from './recorder'
import { FLEET_SHAPE_TYPES } from '../shapes/fleet-utils'
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

function recordingShapeIds(events: RecordingEvent[]): Set<string> {
  const ids = new Set<string>()
  for (const event of events) {
    if (event.kind !== 'stroke') continue
    for (const record of event.put) ids.add(record.id as string)
    for (const id of event.remove) ids.add(id)
  }
  return ids
}

/**
 * The document as it stood before the recording started: the base snapshot with
 * every shape the recording will draw removed, so the replay puts them back in
 * the order they were made rather than showing the finished state at t=0.
 */
export function frozenPlaybackStore(
  recording: RecordingMeta,
  shapeUtils: TLAnyShapeUtilConstructor[],
): TLStore {
  const store = createTLStore({ shapeUtils })
  if (recording.baseSnapshot) loadSnapshot(store, recording.baseSnapshot)
  const replayed = recordingShapeIds(recording.events)
  const remove: TLShapeId[] = []
  for (const record of store.allRecords()) {
    if (record.typeName !== 'shape') continue
    if (replayed.has(record.id as string) || FLEET_SHAPE_TYPES.has(record.type)) remove.push(record.id as TLShapeId)
  }
  if (remove.length) store.remove(remove)
  return store
}

/**
 * The shape utils the replay store needs to read a snapshot.
 *
 * `SvgDocument` publishes these on the window when it builds them. Reaching for
 * that rather than importing `createDocumentShapeUtils` is deliberate: it is
 * defined in `SvgDocument`, which imports this shape, and the cycle bites at
 * module init rather than anywhere you would look for it. A doc-view only ever
 * renders inside a mounted document, so the hatch is always populated.
 */
export function documentShapeUtils(): TLAnyShapeUtilConstructor[] | null {
  const utils = (window as Window & { __tldraw_shape_utils__?: unknown }).__tldraw_shape_utils__
  return Array.isArray(utils) ? utils : null
}
