/**
 * DraftPill — viewer control for draft annotations.
 * Shows draft count; click to publish all.
 */
import { useState, useEffect, useRef, useSyncExternalStore } from 'react'
import { useEditor } from 'tldraw'
import {
  getDraftCount,
  subscribeDrafts,
  publishAllDrafts,
} from './annotationVisibility'
import './DraftPill.css'

export function DraftPill() {
  const editor = useEditor()
  const [showPopup, setShowPopup] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const draftCount = useSyncExternalStore(subscribeDrafts, getDraftCount)

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
          <div
            className="draft-pill-action"
            onClick={() => {
              publishAllDrafts(editor)
              setShowPopup(false)
            }}
          >
            Publish {draftCount} draft{draftCount !== 1 ? 's' : ''}
          </div>
          <div className="draft-pill-hint">
            Drafts are only visible to you until published
          </div>
        </div>
      )}
    </div>
  )
}
