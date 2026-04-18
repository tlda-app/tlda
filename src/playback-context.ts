/**
 * playback-context.ts — Module-level registry for PlaybackFrame data.
 *
 * PlaybackFrameShape registers itself here when mounted/updated.
 * fleet-data-adapter hooks check this registry by parentId to decide
 * whether to return live SSE data or playback-filtered data.
 *
 * Subscription model: hooks subscribe to a frameId; PlaybackFrame
 * calls notifyPlaybackUpdated() when currentMs changes, forcing re-render.
 */

export interface TimewarpRegion {
  start_ms: number
  end_ms: number
  speed: number
  description?: string
}

export interface Timewarp {
  name: string
  regions: TimewarpRegion[]
}

export interface PlaybackData {
  /** All events from the recording (unfiltered) */
  events: PlaybackEvent[]
  /** Agents from recording metadata */
  agents: PlaybackAgent[]
  /** Current scrubber position in ms from recording start */
  currentMs: number
  /** Total duration of recording in ms */
  duration_ms: number
  /** Recording metadata */
  title: string
  created: string
  /** All available timewarps (named cuts) from this recording's edits */
  timewarps?: Timewarp[]
  /** Active timewarp (null = no speed mapping, use baseSpeed directly) */
  activeTimewarp?: Timewarp | null
}

export interface PlaybackEvent {
  t: number        // ms from start
  type: string
  source: string
  sourceId?: string
  data: Record<string, any>
}

export interface PlaybackAgent {
  id: string
  friendly_name?: string
  human?: boolean
}

type Listener = () => void

const registry = new Map<string, PlaybackData>()
const listeners = new Map<string, Set<Listener>>()

/** Register or update playback data for a frame shape */
export function updatePlayback(frameId: string, data: PlaybackData): void {
  registry.set(frameId, data)
  listeners.get(frameId)?.forEach(cb => cb())
}

/** Remove a frame's playback data (called on shape unmount) */
export function unregisterPlayback(frameId: string): void {
  registry.delete(frameId)
  listeners.delete(frameId)
}

/** Get current playback data for a frame, or null if not registered */
export function getPlaybackData(frameId: string): PlaybackData | null {
  return registry.get(frameId) ?? null
}

/**
 * Subscribe to updates for a specific frame.
 * Returns an unsubscribe function.
 * Used by fleet-data-adapter hooks to re-render when currentMs changes.
 */
export function subscribePlayback(frameId: string, cb: Listener): () => void {
  if (!listeners.has(frameId)) listeners.set(frameId, new Set())
  listeners.get(frameId)!.add(cb)
  return () => {
    listeners.get(frameId)?.delete(cb)
  }
}

/**
 * Transform playback events into the format expected by FleetChatShape:
 * { from, to, text, timestamp, _dbId, type }
 * Filters to events with t <= currentMs and of type 'chat'.
 */
export function getPlaybackChatEvents(
  data: PlaybackData,
  dnfFilter: [string, string][][] | null,
): any[] {
  const baseTs = data.created ? new Date(data.created).getTime() : 0

  return data.events
    .filter(e => e.t <= data.currentMs && e.type === 'chat')
    .map(e => ({
      from: e.data.from ?? '',
      to: e.data.to ?? '',
      text: e.data.text ?? '',
      timestamp: baseTs + e.t,
      _dbId: `playback:${e.t}:${e.data.from}`,
      type: 'chat',
    }))
    .filter(e => {
      if (!dnfFilter || dnfFilter.length === 0) return true
      // DNF: match if any conjunction matches.
      // Each term is a [role, label] tuple — role is 'from' or 'to', label is agent ID or name.
      return dnfFilter.some(conj =>
        conj.every(term => {
          const [role, label] = Array.isArray(term) ? term : ['from', term as unknown as string]
          const target = role === 'from' ? e.from : role === 'to' ? e.to : null
          if (!target) return false
          const lbl = label.toLowerCase()
          return target.toLowerCase().includes(lbl)
        })
      )
    })
}

/**
 * Build a minimal agent list from the recording's agent IDs.
 * Returns objects with enough shape for FleetChatShape to render nicks.
 */
export function getPlaybackAgents(data: PlaybackData): any[] {
  return data.agents.map(a => ({
    id: a.id,
    friendly_name: a.friendly_name ?? null,
    dead: false,
    human: !!a.human,
    // Use current time so FleetAgentsShape treats them as alive (not stale)
    last_seen: new Date().toISOString(),
    labels: [],
  }))
}

/**
 * Get the effective playback speed at a given time position.
 * If an activeTimewarp is set, looks up the region speed and multiplies by baseSpeed.
 * Jump regions (>100x) are handled by the caller (snap to region end).
 */
export function getEffectiveSpeed(
  timewarp: Timewarp | null | undefined,
  t: number,
  baseSpeed: number,
): number {
  if (!timewarp || !timewarp.regions.length) return baseSpeed
  for (const r of timewarp.regions) {
    if (t >= r.start_ms && t < r.end_ms) return r.speed * baseSpeed
  }
  return baseSpeed
}

/**
 * Extract all timewarps from a recording's edits array.
 *
 * Two formats are supported:
 * 1. op: 'timewarp' with a timewarp sub-object (named cut with explicit regions)
 * 2. op: 'speed' with start_ms, end_ms, factor (implicit "edits" timewarp)
 *
 * For format 2, all speed edits are merged into a single Timewarp named "edits"
 * with 1x speed for any gaps between the speed regions.
 */
export function extractTimewarps(edits: any[], durationMs?: number): Timewarp[] {
  if (!Array.isArray(edits)) return []

  // Format 1: named timewarp objects
  const named = edits
    .filter((e: any) => e.op === 'timewarp' && e.timewarp)
    .map((e: any) => e.timewarp as Timewarp)

  // Format 2: speed edits — build one synthetic timewarp
  const speedEdits = edits.filter((e: any) => e.op === 'speed' &&
    typeof e.start_ms === 'number' && typeof e.end_ms === 'number' && typeof e.factor === 'number')

  if (speedEdits.length > 0) {
    // Sort by start time, then fill gaps with 1x regions
    const sorted = [...speedEdits].sort((a: any, b: any) => a.start_ms - b.start_ms)
    const regions: TimewarpRegion[] = []
    let cursor = 0
    for (const e of sorted) {
      if (e.start_ms > cursor) {
        regions.push({ start_ms: cursor, end_ms: e.start_ms, speed: 1 })
      }
      regions.push({ start_ms: e.start_ms, end_ms: e.end_ms, speed: e.factor })
      cursor = e.end_ms
    }
    if (durationMs && cursor < durationMs) {
      regions.push({ start_ms: cursor, end_ms: durationMs, speed: 1 })
    }
    named.push({ name: 'edits', regions })
  }

  return named
}

export interface SubtitleEntry {
  t: number
  text: string
}

/**
 * Extract subtitle entries from recording edits.
 * Format: { op: 'subs', subs: [{ t: ms, text: string }, ...] }
 */
export function extractSubs(edits: any[]): SubtitleEntry[] {
  if (!Array.isArray(edits)) return []
  const all: SubtitleEntry[] = []
  for (const e of edits) {
    if (e.op === 'subs' && Array.isArray(e.subs)) {
      for (const s of e.subs) {
        if (typeof s.t === 'number' && typeof s.text === 'string') {
          all.push({ t: s.t, text: s.text })
        }
      }
    }
  }
  return all.sort((a, b) => a.t - b.t)
}

/**
 * Returns the active subtitle at currentMs, or null if none.
 * A subtitle is active from its t until the next subtitle's t (or end of recording).
 */
export function getCurrentSubtitle(subs: SubtitleEntry[], currentMs: number): string | null {
  if (subs.length === 0) return null
  let active: SubtitleEntry | null = null
  for (const s of subs) {
    if (s.t <= currentMs) active = s
    else break
  }
  if (!active) return null
  // Find next subtitle to determine end time
  const idx = subs.indexOf(active)
  const next = subs[idx + 1]
  // No gap handling — subtitle shows until the next one starts
  if (next && currentMs >= next.t) return null
  return active.text
}

/**
 * Returns layout keyframe events at or before currentMs.
 * A layout keyframe has type 'layout' and data: { shapes: { [id]: { x, y } } }
 */
export function getLayoutKeyframe(data: PlaybackData): Record<string, { x: number; y: number }> | null {
  const keyframes = data.events.filter(e => e.t <= data.currentMs && e.type === 'layout')
  if (keyframes.length === 0) return null
  const last = keyframes[keyframes.length - 1]
  return last.data.shapes as Record<string, { x: number; y: number }> ?? null
}
