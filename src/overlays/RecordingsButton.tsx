/**
 * RecordingsButton — opens a small list of this project's recordings; selecting one
 * starts playback (PlaybackOverlay). Sits next to the Record button.
 */

import { useCallback, useContext, useEffect, useState } from 'react'
import './RecordingsButton.css'
import { stopEventPropagation } from 'tldraw'
import { listRecordingDrafts, listRecordings, type RecordingSummary } from '../recording/recordingApi'
import { openPlayback, subscribePlaybackOpen } from '../recording/playbackController'
import { ProjectContext } from '../PanelContext'
import { useBook } from '../BookContext'
import { canPublishRecording } from '../authToken'

function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function RecordingsButton() {
  const project = useContext(ProjectContext)
  const book = useBook()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<RecordingSummary[]>([])
  const [playbackOpen, setPlaybackOpen] = useState(false)

  useEffect(() => subscribePlaybackOpen((id) => setPlaybackOpen(!!id)), [])

  const toggle = useCallback(async () => {
    if (open) { setOpen(false); return }
    const doc = book?.bookName ?? project?.projectName
    if (!doc) return
    const [published, drafts] = await Promise.all([
      listRecordings(doc),
      canPublishRecording() ? listRecordingDrafts(doc) : Promise.resolve([]),
    ])
    setItems([...drafts, ...published])
    setOpen(true)
  }, [book?.bookName, open, project?.projectName])

  // Hide the list entry point while a playback is active (the overlay owns the screen).
  if (playbackOpen) return null

  return (
    <div className="recordings-button-wrap" onPointerDown={stopEventPropagation}>
      {open && (
        <div className="recordings-list">
          {items.length === 0 && <div className="recordings-list__empty">No recordings yet</div>}
          {items.map((r) => (
            <button
              key={r.id}
              className="recordings-list__item"
              onClick={() => { openPlayback(r.privateDraft ? `draft:${r.id}` : r.id); setOpen(false) }}
            >
              <span className="recordings-list__title">{r.privateDraft ? 'Private draft · ' : ''}{r.title}</span>
              <span className="recordings-list__dur">{fmtDur(r.duration_ms)}</span>
            </button>
          ))}
        </div>
      )}
      <button className="recordings-button" onClick={toggle} title="Play a recording">▶</button>
    </div>
  )
}
