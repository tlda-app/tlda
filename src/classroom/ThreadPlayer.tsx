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
 * The layer plays in its own read-only editor beside the transport, through
 * the same `DocViewSpacetimeBody` a doc-view uses — one layer, one engine, one
 * audio clock, nothing new.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useDocViewPlayback } from '../recording/useDocViewPlayback'
import { DocViewSpacetimeBody } from '../shapes/DocViewSpacetime'
import { formatTimecode } from '../recording/timeControls'
import { type ThreadLayerSummary } from '../recording/annotationThread'
import { threadLayers } from '../../shared/annotation-thread.mjs'
import { threadSpeakerLabel } from '../../shared/thread-layer-author.mjs'
import type { AnswerRef } from '../recording/recorder'
import type { PlayingLayer } from './replyLayer'
import './ThreadPlayer.css'

export interface ThreadPlayerProps {
  answer: AnswerRef
  /** The project the answer's layers are stored under. */
  doc: string
  /**
   * Who is looking at the thread: the speaker reads "You" for the row's own
   * author and "Student"/"Instructor" otherwise. Passed in rather than fetched
   * here, because the caller (`MarkingInkOverlay`) already knows the pair's
   * viewer role and the student id it belongs to.
   */
  viewer?: { role: 'instructor' } | { role: 'student'; studentId: string }
  /**
   * This answer's layers, fetched by the caller.
   *
   * Not fetched here, and that is about a real number rather than tidiness: a
   * student arrives with every answer they have open — thirteen, measured on
   * `8825e2af4` — so a player that listed for itself would make thirteen
   * identical requests for one project's recordings. The caller holds the pairs
   * and can ask once.
   */
  layers: ThreadLayerSummary[]
  /**
   * The layer now playing, or null. Passed up so the plus can answer it — the
   * plus replies to whatever is open, which is what makes "reply to anything"
   * reachable without a picker.
   */
  onPlayingChange: (playing: PlayingLayer | null) => void
}

export function ThreadPlayer({ answer, doc, viewer, layers, onPlayingChange }: ThreadPlayerProps) {
  const [selected, setSelected] = useState<string | null>(null)

  // Who said each layer. The server stamps the author from classroom identity
  // at record time; a layer recorded before that carries none and reads as an
  // unlabelled entry rather than a wrong speaker. The contract lives in
  // `shared/thread-layer-author.mjs` and is consumed here, not duplicated.
  const speakerOf = (layer: ThreadLayerSummary): string | null =>
    threadSpeakerLabel({ author: layer.author ?? null, viewer: viewer ?? null })

  // This answer's own layers, and oldest first: stored newest first, but a
  // thread reads in the order things were said.
  const ordered = useMemo(
    () => threadLayers(layers, answer).slice().reverse() as ThreadLayerSummary[],
    [layers, answer],
  )

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

  if (!ordered.length) return null

  // The player keeps the header's inline shape while nothing is open, and grows
  // a canvas under the transport once a layer is selected.
  return (
    <span className={`tlda-thread-player${selected ? ' tlda-thread-player-open' : ''}`}>
      <span className="tlda-thread-player-transport">
        <select
          value={selected ?? ''}
          onChange={(event) => setSelected(event.target.value || null)}
          aria-label="Layer to play"
        >
          <option value="">Layers…</option>
          {ordered.map((layer, index) => {
            const speaker = speakerOf(layer)
            return (
              <option key={layer.id} value={layer.id}>
                {`${index + 1}. ${speaker ? `${speaker} · ` : ''}${formatTimecode(layer.duration_ms ?? 0)}`}
                {layer.parentLayerId ? ' ↳' : ''}
              </option>
            )
          })}
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

      {/* The ink, redrawing as it was drawn. The player hook already owns the
          frozen store and the engine mount; this is the same body a doc-view
          uses, in a fixed-height frame so the answer header keeps its shape
          whether or not a layer is open. 320px is a layout call: tall enough
          for a mark to read, short enough to sit beside an answer. */}
      {selected && (
        <span className="tlda-thread-player-canvas">
          <DocViewSpacetimeBody playback={playback} height={PLAYER_CANVAS_HEIGHT} />
        </span>
      )}
    </span>
  )
}

/** Fixed frame height for the player editor. See the note at the mount. */
const PLAYER_CANVAS_HEIGHT = 320
