/**
 * PlaybackPill — shows when fleet playback is active.
 * Pulsing dot + timestamp, matching the subtle pill conventions.
 */

import type { PlaybackState } from '../hooks/useSyncedPlayback'
import './PlaybackPill.css'

interface PlaybackPillProps {
  state: PlaybackState
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function PlaybackPill({ state }: PlaybackPillProps) {
  if (!state.active) return null

  return (
    <span className="playback-pill" title={`Fleet playback at ${state.ts ? new Date(state.ts).toLocaleString() : '?'}`}>
      <span className="playback-dot" />
      {state.ts ? formatTime(state.ts) : 'playing'}
      {state.speed !== 1 && ` ${state.speed}x`}
    </span>
  )
}
