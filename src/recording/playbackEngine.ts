/**
 * playbackEngine.ts — M2 of voice-classroom (frozen-doc model).
 *
 * A recording IS a document: opening one mounts a private tldraw store seeded with
 * a frozen copy of the doc (its pages), and playback is just that store *changing
 * over time* — the recorded diffs replayed into it. The live document is never
 * touched; you're looking at the recording's own doc.
 *
 * This engine drives that player editor:
 *  - the solid shape at time t is its STATE at t (reconstructAt), so mid-lecture
 *    moves/edits replay natively — nothing is collapsed to a final form;
 *  - shapes whose create-diff hasn't played yet show faint (ghost);
 *  - the camera follows the recorded camera.
 *
 * The player store is local (not synced), so plain put/remove is fine — there's no
 * sync layer to guard against and nothing to pollute.
 */

import type { Editor, TLRecord, TLShapeId } from 'tldraw'
import type { RecordingEvent, StrokeEvent, CameraEvent, BaseEvent } from './recorder'

const GHOST_OPACITY = 0.22

function isStroke(e: RecordingEvent): e is StrokeEvent {
  return e.kind === 'stroke'
}
function isCamera(e: RecordingEvent): e is CameraEvent {
  return e.kind === 'camera'
}
function isBase(e: RecordingEvent): e is BaseEvent {
  return e.kind === 'base'
}

export function playbackSegmentAt(events: RecordingEvent[], t: number): {
  base: BaseEvent | null
  events: RecordingEvent[]
} {
  let base: BaseEvent | null = null
  let baseIndex = -1
  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    if (event.t > t) break
    if (isBase(event)) { base = event; baseIndex = index }
  }
  if (baseIndex < 0) return { base, events }
  const relativeNext = events.slice(baseIndex + 1).findIndex(isBase)
  const segmentEnd = relativeNext < 0 ? events.length : baseIndex + 1 + relativeNext
  return { base, events: events.slice(baseIndex + 1, segmentEnd) }
}

/**
 * The recorded shapes present at time t, in their state AT t: for each id, the last
 * put at or before t wins; a trailing remove means absent. This is what makes
 * mid-lecture edits and MOVES replay — the shape tracks its props as t advances.
 */
function reconstructAt(events: RecordingEvent[], t: number): Map<string, TLRecord> {
  const visible = new Map<string, TLRecord>()
  for (const e of events) {
    if (e.t > t || !isStroke(e)) continue
    for (const r of e.put) visible.set(r.id as string, r)
    for (const id of e.remove) visible.delete(id)
  }
  return visible
}

/** Per recorded id: when it first appeared, when (if ever) it was erased, final form. */
interface StrokeLife {
  firstT: number
  removeT: number // Infinity if never erased
  finalRecord: TLRecord
}

function lifetimesOf(events: RecordingEvent[]): Map<string, StrokeLife> {
  const lives = new Map<string, StrokeLife>()
  for (const e of events) {
    if (!isStroke(e)) continue
    for (const r of e.put) {
      const id = r.id as string
      const existing = lives.get(id)
      if (existing) {
        existing.finalRecord = r
        if (e.t < existing.firstT) existing.firstT = e.t
        if (e.t >= existing.removeT) existing.removeT = Infinity
      } else {
        lives.set(id, { firstT: e.t, removeT: Infinity, finalRecord: r })
      }
    }
    for (const id of e.remove) {
      const existing = lives.get(id)
      if (existing) existing.removeT = e.t
    }
  }
  return lives
}

/** Last camera position at or before t, or null if none. */
function cameraAt(events: RecordingEvent[], t: number): CameraEvent | null {
  let last: CameraEvent | null = null
  for (const e of events) {
    if (e.t > t) break
    if (isCamera(e)) last = e
  }
  return last
}

export class PlaybackEngine {
  private editor: Editor // the recording PLAYER's editor (its own frozen-doc store)
  private events: RecordingEvent[]
  private lives: Map<string, StrokeLife>
  /** id -> the record currently shown (solid), or the sentinel 'ghost'. */
  private shown = new Map<string, TLRecord | 'ghost'>()
  private active = false
  private loadedBase: BaseEvent | null = null
  private excludedShapeTypes: ReadonlySet<string>

  followCamera = true

  constructor(editor: Editor, events: RecordingEvent[], excludedShapeTypes: ReadonlySet<string> = new Set()) {
    this.editor = editor
    this.events = events
    this.lives = lifetimesOf(events)
    this.excludedShapeTypes = excludedShapeTypes
  }

  /** Fold newly saved events (e.g. fresh additions) into the timeline; the next seek renders them. */
  addEvents(evts: RecordingEvent[]): void {
    if (!evts.length) return
    this.events = [...this.events, ...evts].sort((a, b) => a.t - b.t)
    this.lives = lifetimesOf(this.events)
  }

  /** Show the resting state: the whole lecture ghosted over the frozen doc. */
  enter(): void {
    if (this.active) return
    this.active = true
    this.seek(0)
  }

  /** Render the player at time t (ms). Idempotent — safe to call every frame. */
  seek(t: number): void {
    if (!this.active) return

    const segment = playbackSegmentAt(this.events, t)
    const { base } = segment
    const segmentEvents = segment.events
    if (base && base !== this.loadedBase) {
      this.lives = lifetimesOf(segmentEvents)
      this.editor.loadSnapshot(base.snapshot)
      const replayedIds = new Set(this.lives.keys())
      const remove: TLShapeId[] = []
      for (const record of this.editor.store.allRecords()) {
        if (record.typeName !== 'shape') continue
        if (replayedIds.has(record.id as string) || this.excludedShapeTypes.has(record.type)) {
          remove.push(record.id as TLShapeId)
        }
      }
      if (remove.length) this.editor.store.remove(remove)
      this.shown.clear()
      this.loadedBase = base
    }

    const solid = reconstructAt(segmentEvents, t)
    const desired = new Map<string, TLRecord | 'ghost'>()
    for (const [id, rec] of solid) desired.set(id, rec)
    for (const [id, life] of this.lives) {
      if (desired.has(id)) continue
      if (t < life.firstT && t < life.removeT) desired.set(id, 'ghost')
    }

    const toPut: TLRecord[] = []
    const toRemove: TLShapeId[] = []

    for (const [id, val] of desired) {
      const prev = this.shown.get(id)
      if (val === 'ghost') {
        if (prev !== 'ghost') {
          toPut.push({ ...this.lives.get(id)!.finalRecord, opacity: GHOST_OPACITY } as TLRecord)
        }
      } else if (prev !== val) {
        // Newly solid, or the record changed (a move/edit landed at this t).
        toPut.push(val)
      }
    }
    for (const id of this.shown.keys()) {
      if (!desired.has(id)) toRemove.push(id as TLShapeId)
    }

    if (toRemove.length) this.editor.store.remove(toRemove)
    if (toPut.length) this.editor.store.put(toPut)
    this.shown = desired

    if (this.followCamera) {
      const cam = cameraAt(segmentEvents, t)
      if (cam) this.editor.setCamera({ x: cam.x, y: cam.y, z: cam.z })
    }
  }

  /** Clear the replayed strokes from the player store. */
  exit(): void {
    if (!this.active) return
    this.active = false
    const ids = [...this.shown.keys()].map((id) => id as TLShapeId)
    if (ids.length) this.editor.store.remove(ids)
    this.shown.clear()
    this.loadedBase = null
  }
}
