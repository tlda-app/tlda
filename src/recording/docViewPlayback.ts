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

// The time-control states and the recording-ref encoding live in
// `timeControls.ts` — pure, and importable without tldraw so they can be
// exercised rather than read. Re-exported so callers keep one import surface.
export {
  defaultTimeControlsMode,
  formatTimecode,
  parseRecordingRef,
  recordingRef,
  timeControlsMode,
  type TimeControlsMode,
} from './timeControls'

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
