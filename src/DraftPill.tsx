/**
 * DraftPill — viewer control for draft annotations.
 * Shows draft count; click to publish all or publish selected.
 */
import { useState, useEffect, useRef, useMemo, useSyncExternalStore } from 'react'
import { useEditor, useValue } from 'tldraw'
import {
  getDraftCount,
  getDraftIds,
  isDraft,
  subscribeDrafts,
  publishAllDrafts,
  publishDrafts,
} from './annotationVisibility'
import './DraftPill.css'

export function DraftPill() {
  const editor = useEditor()
  const [showPopup, setShowPopup] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const draftCount = useSyncExternalStore(subscribeDrafts, getDraftCount)

  // Track how many selected shapes are drafts
  const selectedIds = useValue('selectedIds', () => editor.getSelectedShapeIds(), [editor])
  const selectedDraftIds = useMemo(
    () => selectedIds.filter(id => isDraft(id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedIds, draftCount] // draftCount as dep so we re-filter when drafts change
  )

  useEffect(() => {
    if (!showPopup) return
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowPopup(false)
      }
    }
    document.addEventListener('pointerdown', handleClick, true)
    return () => document.removeEventListener('pointerdown', handleClick, true)
  }, [showPopup])

  if (draftCount === 0) return null

  const hasSelection = selectedDraftIds.length > 0

  return (
    <div className="draft-pill-container" ref={containerRef}>
      <span
        className="draft-pill-badge"
        onClick={() => setShowPopup(s => !s)}
        onPointerDown={e => e.stopPropagation()}
        title={`${draftCount} draft${draftCount !== 1 ? 's' : ''} (not yet visible to others)`}
      >
        {draftCount}
      </span>
      {showPopup && (
        <div
          className="draft-pill-popup"
          onPointerDown={e => e.stopPropagation()}
        >
          {hasSelection && (
            <div
              className="draft-pill-action"
              onClick={() => {
                publishDrafts(editor, selectedDraftIds)
                setShowPopup(false)
              }}
            >
              Publish {selectedDraftIds.length} selected
            </div>
          )}
          <div
            className="draft-pill-action"
            onClick={() => {
              publishAllDrafts(editor)
              setShowPopup(false)
            }}
          >
            Publish all {draftCount}
          </div>
          <div className="draft-pill-hint">
            Drafts are only visible to you until published
          </div>
        </div>
      )}
    </div>
  )
}
