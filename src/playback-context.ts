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
  dnfFilter: string[][] | null,
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
      // DNF: match if any conjunction matches
      return dnfFilter.some(conj =>
        conj.every(term => {
          const t = term.toLowerCase()
          return (
            e.from?.toLowerCase().includes(t) ||
            e.to?.toLowerCase().includes(t) ||
            e.text?.toLowerCase().includes(t)
          )
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
    human: a.id === 'fleet:skip' || a.id.includes('skip'),
    last_seen: new Date(data.created).toISOString(),
    labels: [],
  }))
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
