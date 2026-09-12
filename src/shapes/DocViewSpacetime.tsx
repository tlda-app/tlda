/**
 * DocViewSpacetime — a doc-view's body when it is showing a recording, and the
 * transport that drives it.
 *
 * The shape does not change. A doc-view is a framed, independently-cameraed,
 * clipped view of the document; spacetime changes which document state is in
 * the frame — the live one, or one being replayed — and nothing else about it.
 *
 * The replayed body is a second editor over a frozen store, which is what
 * `RecordingViewer` has always done and the only thing that can work: the clip
 * panel renders a viewport of the editor it is mounted under, so a store that
 * is not the main store needs its own editor to be viewed at all. Both bodies
 * are read-only, both have a camera nobody else moves, and both are clipped to
 * the doc-view frame.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Tldraw, stopEventPropagation } from 'tldraw'
import { LICENSE_KEY } from '../activeConfig'
import {
  editOwnerClassInterval,
  listRecordingDrafts,
  listRecordings,
  proposeClassInterval,
  publishClassInterval,
  type RecordingSummary,
} from '../recording/recordingApi'
import { canPublishRecording, subscribeCanPresent } from '../authToken'
import {
  documentShapeUtils,
  formatTimecode,
  parseRecordingRef,
  recordingRef,
  type TimeControlsMode,
} from '../recording/docViewPlayback'
import type { DocViewPlayback } from '../recording/useDocViewPlayback'
import './DocViewSpacetime.css'

/** The replayed document, in the doc-view's frame. */
export function DocViewSpacetimeBody({ playback, height }: { playback: DocViewPlayback; height: number }) {
  const { store, meta, onEditorMount } = playback
  const shapeUtils = documentShapeUtils()
  if (!store || !shapeUtils) {
    return (
      <div className="docview-spacetime-empty" style={{ height }}>
        {meta ? 'loading recording…' : 'select a recording'}
      </div>
    )
  }
  return (
    <div className="docview-spacetime-canvas" style={{ height }}>
      <Tldraw
        store={store}
        shapeUtils={shapeUtils}
        licenseKey={LICENSE_KEY}
        hideUi
        forceMobile
        onMount={onEditorMount}
      />
    </div>
  )
}

/**
 * The transport: which recording, play, scrub, mute.
 *
 * It docks to the bottom of the doc-view. In `auto-hide` it sits below the edge
 * until the pointer reaches the strip along the bottom, which is why the strip
 * is a sibling rather than a hover on the bar itself — a bar that is off screen
 * cannot be hovered.
 */
export function DocViewTimeControls({
  playback,
  projectName,
  mode,
  selected,
  onSelect,
}: {
  playback: DocViewPlayback
  projectName: string
  mode: TimeControlsMode
  selected: string | undefined
  onSelect: (ref: string) => void
}) {
  const [listOpen, setListOpen] = useState(false)
  const [items, setItems] = useState<RecordingSummary[]>([])
  const [revealed, setRevealed] = useState(false)
  const [reviewStatus, setReviewStatus] = useState('')
  const [startMs, setStartMs] = useState(0)
  const [endMs, setEndMs] = useState(0)
  const publisher = useSyncExternalStore(subscribeCanPresent, canPublishRecording)

  const {
    meta, duration, currentMs, playing, muted, hasAudio,
    attachAudio, audioSrc, play, pause, scrub, setMuted, noteAudioMissing,
  } = playback

  useEffect(() => {
    setStartMs(meta?.publication?.startMs ?? 0)
    setEndMs(meta?.publication?.endMs ?? meta?.duration_ms ?? 0)
    setReviewStatus(meta?.publication ? 'Class interval proposed' : '')
  }, [meta])

  const openList = useCallback(async () => {
    if (listOpen) { setListOpen(false); return }
    const [published, drafts] = await Promise.all([
      listRecordings(projectName),
      canPublishRecording() ? listRecordingDrafts(projectName) : Promise.resolve([]),
    ])
    setItems([...drafts, ...published])
    setListOpen(true)
  }, [listOpen, projectName])

  const selectionLabel = meta?.title ?? (selected ? 'loading…' : 'Recordings')
  const privateDraft = !!meta?.privateDraft
  const recordingId = parseRecordingRef(selected)?.id

  const publishInterval = async () => {
    if (!recordingId) return
    setReviewStatus('Publishing selected interval…')
    try {
      await publishClassInterval(projectName, recordingId)
      setReviewStatus('Published')
    } catch (error) { setReviewStatus(error instanceof Error ? error.message : String(error)) }
  }
  // Saving the owner's boundaries needs a proposed interval to edit. When an
  // agent has already proposed one this edits it, which is the two-party path.
  // When nobody has, the owner proposes it themselves first -- otherwise this
  // button fails with "Recording needs an agent proposal before owner review"
  // and the teacher cannot publish their own lecture without an agent running an
  // MCP call that has no UI. Both actors are then the owner, which the record
  // says plainly in `proposedBy` and `ownerEditedBy`.
  const saveOwnerInterval = async () => {
    if (!recordingId) return
    const proposing = !meta?.publication
    setReviewStatus(proposing ? 'Proposing class interval…' : 'Saving owner boundaries…')
    try {
      if (proposing) await proposeClassInterval(projectName, recordingId, startMs, endMs)
      await editOwnerClassInterval(projectName, recordingId, startMs, endMs)
      setReviewStatus('Owner boundaries saved')
    } catch (error) { setReviewStatus(error instanceof Error ? error.message : String(error)) }
  }

  if (mode === 'off') return null
  const shown = mode === 'pinned' || revealed || listOpen

  return (
    <div
      className="docview-spacetime-dock"
      onPointerDown={stopEventPropagation}
      onWheel={stopEventPropagation}
    >
      {mode === 'auto-hide' && (
        <div
          className="docview-spacetime-reveal"
          onPointerEnter={() => setRevealed(true)}
          aria-hidden
        />
      )}
      <div
        className={`docview-spacetime-bar${shown ? ' is-shown' : ''}`}
        onPointerLeave={() => { if (mode === 'auto-hide' && !listOpen) setRevealed(false) }}
      >
        {listOpen && (
          <div className="docview-spacetime-list">
            {items.length === 0 && <div className="docview-spacetime-list__empty">No recordings yet</div>}
            {items.map((item) => (
              <button
                key={recordingRef(item.id, item.privateDraft)}
                className="docview-spacetime-list__item"
                onClick={() => { onSelect(recordingRef(item.id, item.privateDraft)); setListOpen(false) }}
              >
                <span className="docview-spacetime-list__title">
                  {item.privateDraft ? 'Private draft · ' : ''}{item.title}
                </span>
                <span className="docview-spacetime-list__dur">{formatTimecode(item.duration_ms)}</span>
              </button>
            ))}
          </div>
        )}
        <button
          className="docview-spacetime-btn docview-spacetime-pick"
          onClick={openList}
          title="Choose a recording to play in this doc-view"
        >{selectionLabel}</button>
        <button
          className="docview-spacetime-btn"
          onClick={playing ? pause : play}
          disabled={duration <= 0}
          title={playing ? 'Pause' : 'Play'}
        >{playing ? '❚❚' : '▶'}</button>
        <span className="docview-spacetime-time">{formatTimecode(currentMs)}</span>
        <input
          className="docview-spacetime-slider"
          type="range"
          min={0}
          max={Math.max(1, duration)}
          value={Math.min(currentMs, duration)}
          disabled={duration <= 0}
          onChange={(event) => scrub(Number(event.target.value))}
        />
        <span className="docview-spacetime-time">{formatTimecode(duration)}</span>
        {/* Stays on the bar with no audio track, disabled — a control that
            appears and disappears with the recording is harder to read than one
            that is visibly unavailable. */}
        <button
          className="docview-spacetime-btn docview-spacetime-mute"
          onClick={() => setMuted(!muted)}
          disabled={!hasAudio}
          title={hasAudio ? (muted ? 'Unmute' : 'Mute') : 'This recording has no audio track'}
        >{muted || !hasAudio ? '🔇' : '🔊'}</button>
      </div>
      {shown && privateDraft && (
        <div className="docview-spacetime-review">
          <label>Start <input type="number" min={0} max={endMs / 1000} step="0.1" value={startMs / 1000} onChange={(event) => setStartMs(Number(event.target.value) * 1000)} /> s</label>
          <button onClick={() => setStartMs(Math.min(currentMs, endMs - 1))}>Set start here</button>
          <label>End <input type="number" min={startMs / 1000} max={duration / 1000} step="0.1" value={endMs / 1000} onChange={(event) => setEndMs(Number(event.target.value) * 1000)} /> s</label>
          <button onClick={() => setEndMs(Math.max(currentMs, startMs + 1))}>Set end here</button>
          {publisher
            ? <><button onClick={saveOwnerInterval}>Save my boundaries</button><button onClick={publishInterval}>Publish selected class</button></>
            : null}
          <span>{reviewStatus}</span>
        </div>
      )}
      {audioSrc && (
        <audio
          ref={attachAudio}
          src={audioSrc}
          preload="auto"
          muted={muted}
          onError={noteAudioMissing}
        />
      )}
    </div>
  )
}
