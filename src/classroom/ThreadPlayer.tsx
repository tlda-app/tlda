/**
 * Playing a layer beside the answer, so a reply can be made against it.
 *
 * This is the surface the warp was waiting for. A warp is a map from a reply's
 * own time into its parent's, and it is sampled from where the parent's
 * playhead *actually was* while the reply recorded — so until a reader could
 * move a playhead, every layer the plus made was a root and no warp existed.
 *
 * It is deliberately built on `useDocViewPlayback` rather than a second player.
 * That hook already owns the hard parts — a clock that survives audio being
 * absent, muted or refused, and a `scrub` that reports a jump to any recording
 * in progress — and the jump report is the thing that makes a scrub read back
 * as a step rather than as a walk through answer nobody saw.
 *
 * No editor is mounted yet, so a layer plays as voice and a moving playhead
 * without its ink replaying. That is a real limit and is the next piece: the
 * hook takes an editor and will drive its `PlaybackEngine` when one is given.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useDocViewPlayback } from '../recording/useDocViewPlayback'
import { formatTimecode } from '../recording/timeControls'
import { listThread, type ThreadLayerSummary } from '../recording/annotationThread'
import type { AnswerRef } from '../recording/recorder'
import type { PlayingLayer } from './replyLayer'
import './ThreadPlayer.css'

export interface ThreadPlayerProps {
  answer: AnswerRef
  /** The project the answer's layers are stored under. */
  doc: string
  /**
   * The layer now playing, or null. Passed up so the plus can answer it — the
   * plus replies to whatever is open, which is what makes "reply to anything"
   * reachable without a picker.
   */
  onPlayingChange: (playing: PlayingLayer | null) => void
  /** Bumped by the caller when a layer is added, so the list refetches. */
  revision?: number
}

export function ThreadPlayer({ answer, doc, onPlayingChange, revision = 0 }: ThreadPlayerProps) {
  const [layers, setLayers] = useState<ThreadLayerSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    listThread(doc, answer)
      .then((found) => { if (!cancelled) setLayers(found) })
      .catch((err) => { if (!cancelled) setError((err as Error).message) })
    return () => { cancelled = true }
  }, [doc, answer.submissionRoomId, answer.problemId, revision])

  // Stored newest first; oldest first is the order they were said in, which is
  // the order a thread reads in.
  const ordered = useMemo(() => [...layers].reverse(), [layers])

  const playback = useDocViewPlayback(doc, selected ? `draft:${selected}` : undefined)
  const { currentMs, duration, playing, play, pause, scrub, attachAudio, audioSrc } = playback

  // The playhead is handed up as a FUNCTION, not as the number it is now. A
  // reply samples the parent repeatedly while it records; a value captured once
  // would report the same instant for the whole reply, which reads back as the
  // reader having stared at one moment rather than moved through the answer.
  const readPlayhead = useCallback(() => currentMs, [currentMs])

  useEffect(() => {
    onPlayingChange(selected ? { layerId: selected, currentMs: readPlayhead } : null)
  }, [selected, readPlayhead, onPlayingChange])

  if (error) return <span className="tlda-thread-player-error">{error}</span>
  if (!ordered.length) return null

  return (
    <span className="tlda-thread-player">
      <select
        value={selected ?? ''}
        onChange={(event) => setSelected(event.target.value || null)}
        aria-label="Layer to play"
      >
        <option value="">Layers…</option>
        {ordered.map((layer, index) => (
          <option key={layer.id} value={layer.id}>
            {`${index + 1}. ${formatTimecode(layer.duration_ms ?? 0)}`}
            {layer.parentLayerId ? ' ↳' : ''}
          </option>
        ))}
      </select>

      {selected && (
        <>
          <button type="button" onClick={() => (playing ? pause() : play())}>
            {playing ? '❙❙' : '▶'}
          </button>
          <input
            type="range"
            min={0}
            max={Math.max(1, duration)}
            value={Math.min(currentMs, duration)}
            // Every move is a jump, and the recorder is told so. Between two
            // samples a drag is indistinguishable from very fast playback.
            onChange={(event) => scrub(Number(event.target.value))}
            aria-label="Playhead"
          />
          <span className="tlda-thread-player-time">
            {formatTimecode(currentMs)} / {formatTimecode(duration)}
          </span>
          {audioSrc && <audio ref={attachAudio} src={audioSrc} preload="metadata" />}
        </>
      )}
    </span>
  )
}
