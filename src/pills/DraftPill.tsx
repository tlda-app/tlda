/**
 * DraftPill — draft mode toggle + publish control.
 * Shows when draft mode is on or there are pending drafts.
 */
import { useState, useEffect, useRef, useMemo, useSyncExternalStore } from 'react'
import { useEditor, useValue } from 'tldraw'
import {
  getDraftCount,
  isDraft,
  subscribeDrafts,
  publishAllDrafts,
  publishDrafts,
  setDraftHovering,
  isDraftMode,
  toggleDraftMode,
  subscribeDraftMode,
} from '../annotationVisibility'
import './DraftPill.css'

export function DraftPill() {
  const editor = useEditor()
  const [showPopup, setShowPopup] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const draftCount = useSyncExternalStore(subscribeDrafts, getDraftCount)
  const draftMode = useSyncExternalStore(subscribeDraftMode, isDraftMode)

  const selectedIds = useValue('selectedIds', () => editor.getSelectedShapeIds(), [editor])
  const selectedDraftIds = useMemo(
    () => selectedIds.filter(id => isDraft(id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedIds, draftCount]
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

  const hasSelection = selectedDraftIds.length > 0

  return (
    <div className="draft-pill-container" ref={containerRef}>
      <span
        className={`draft-pill-badge${draftMode ? ' draft-pill-badge--on' : ''}`}
        onClick={() => setShowPopup(s => !s)}
        onPointerDown={e => e.stopPropagation()}
        onMouseEnter={() => setDraftHovering(true)}
        onMouseLeave={() => setDraftHovering(false)}
        title={draftMode
          ? `Draft mode on${draftCount > 0 ? ` · ${draftCount} pending` : ''}`
          : 'Draft mode off'}
      >
        <DraftBoxIcon on={draftMode} count={draftCount} />
      </span>
      {showPopup && (
        <div
          className="draft-pill-popup"
          onPointerDown={e => e.stopPropagation()}
        >
          <div
            className="draft-pill-action draft-pill-toggle"
            onClick={() => { toggleDraftMode(); setShowPopup(false) }}
          >
            {draftMode ? 'Turn off draft mode' : 'Turn on draft mode'}
          </div>
          {draftCount > 0 && (
            <>
              <div className="draft-pill-divider" />
              {hasSelection && (
                <div
                  className="draft-pill-action"
                  onClick={() => { publishDrafts(editor, selectedDraftIds); setShowPopup(false) }}
                >
                  Publish {selectedDraftIds.length} selected
                </div>
              )}
              <div
                className="draft-pill-action"
                onClick={() => { publishAllDrafts(editor); setShowPopup(false) }}
              >
                Publish all {draftCount}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function DraftBoxIcon({ on, count }: { on: boolean; count: number }) {
  // A small box: diagonal-hatched (pattern fill) when draft mode off,
  // empty when on with no drafts, count text when drafts pending.
  return (
    <svg width="14" height="11" viewBox="0 0 14 11" className="draft-pill-icon">
      {!on && (
        <defs>
          <pattern id="dp-hatch" patternUnits="userSpaceOnUse" width="3" height="3" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="3" stroke="currentColor" strokeWidth="1" />
          </pattern>
          <clipPath id="dp-clip">
            <rect x="2" y="2" width="10" height="7" rx="0.5" />
          </clipPath>
        </defs>
      )}
      {/* hatch fill — clipped to interior, no stroke */}
      {!on && (
        <rect x="2" y="2" width="10" height="7"
          fill="url(#dp-hatch)" stroke="none"
          clipPath="url(#dp-clip)" />
      )}
      {/* border — drawn on top, clean */}
      <rect x="1.5" y="1.5" width="11" height="8" rx="1"
        fill="none" stroke="currentColor" strokeWidth="1.2" />
      {on && count > 0 && (
        <text x="7" y="8.5" textAnchor="middle" fontSize="6.5" fill="currentColor" fontFamily="-apple-system, BlinkMacSystemFont, sans-serif">
          {count}
        </text>
      )}
    </svg>
  )
}
