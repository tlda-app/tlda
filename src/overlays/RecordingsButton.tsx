/**
 * RecordingsButton — the bottom-left way in to lecture playback.
 *
 * Skip asked for a PiP that "can pop out from a button on the bottom left".
 * That button existed, was measured at left 118px / bottom 16px, and was deleted
 * by a8b67d375 when playback moved from the `RecordingViewer` window into the
 * doc-view shape. The move was right -- several doc-views can each show a
 * recording, which one floating window could not -- but it left the classroom
 * with no way to reach playback: `ClassroomDocViewPlayback` renders
 * `fleet-docview` shapes that already exist and belong to you, and nothing in
 * the classroom creates one.
 *
 * The first attempt at this button created that shape (commit 1c340cffe). It is
 * rejected and kept only as evidence. A read-only student's editor is readonly,
 * so `createShape` is a no-op for them -- and `createFleetShape` still returns
 * an id, so the button closed its list and did nothing at all. The student is
 * the whole reason the feature exists, so a route they cannot take is no route.
 *
 * So this owns the selection locally and renders its own fixed surface. It
 * writes no canvas shape, which is why it works for a reader. It is not a
 * revival of the old window either: the replay body, the transport, the
 * recordings list and the owner's review controls are all the current
 * components, driven by the current hook. The only thing that changed hands is
 * where the selection is stored -- a React state here rather than a prop on a
 * synced shape.
 */

import { useCallback, useContext, useState } from 'react'
import { stopEventPropagation } from 'tldraw'
import './RecordingsButton.css'
import { useDocViewPlayback } from '../recording/useDocViewPlayback'
import { DocViewSpacetimeBody, DocViewTimeControls } from '../shapes/DocViewSpacetime'
import { ProjectContext } from '../PanelContext'
import { useBook } from '../BookContext'

const PANEL_BODY_H = 260

export function RecordingsButton() {
  const project = useContext(ProjectContext)
  const book = useBook()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string | undefined>(undefined)

  const projectName = book?.bookName ?? project?.projectName ?? ''
  const playback = useDocViewPlayback(projectName, open ? selected : undefined)

  const toggle = useCallback(() => setOpen(value => !value), [])

  return (
    <>
      {open && (
        <div
          className="recordings-panel"
          onPointerDown={stopEventPropagation}
          onWheel={stopEventPropagation}
        >
          <div className="recordings-panel__bar">
            <span className="recordings-panel__title">Playback</span>
            <button
              className="recordings-panel__close"
              onClick={() => { setOpen(false); setSelected(undefined) }}
              aria-label="Close playback"
            >✕</button>
          </div>
          <DocViewSpacetimeBody playback={playback} height={PANEL_BODY_H} />
          {/* `pinned` so the transport is always on screen here. The doc-view's
              three-state control exists because a doc-view is also a document
              window; this panel is only ever a player. */}
          <DocViewTimeControls
            playback={playback}
            projectName={projectName}
            mode="pinned"
            selected={selected}
            onSelect={setSelected}
          />
        </div>
      )}
      <div className="recordings-button-wrap" onPointerDown={stopEventPropagation}>
        <button
          className="recordings-button"
          onClick={toggle}
          title={open ? 'Hide playback' : 'Play a recording'}
          aria-pressed={open}
        >▶</button>
      </div>
    </>
  )
}
