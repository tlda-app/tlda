import type { PlaybackData, PlaybackEvent } from '../playback-context'
import type { LiveSessionEvent } from './sessionBuffer'

export const LIVEKIT_PLAYBACK_SOURCE = 'livekit-session'

export function liveSessionToPlaybackData({
  id,
  title,
  created,
  events,
  currentMs = 0,
}: {
  id: string
  title: string
  created: string
  events: LiveSessionEvent[]
  currentMs?: number
}): PlaybackData {
  const playbackEvents: PlaybackEvent[] = events
    .filter(event => event.kind === 'canvas' || event.kind === 'camera')
    .map((event) => ({
      t: event.t,
      type: event.kind === 'canvas' ? 'livekit:canvas' : 'livekit:camera',
      source: LIVEKIT_PLAYBACK_SOURCE,
      sourceId: id,
      data: event.kind === 'canvas'
        ? { put: event.put, remove: event.remove }
        : { x: event.x, y: event.y, z: event.z },
    }))
    .sort((a, b) => a.t - b.t)

  return {
    events: playbackEvents,
    agents: [],
    currentMs,
    duration_ms: playbackEvents.at(-1)?.t ?? 0,
    title,
    created,
  }
}
