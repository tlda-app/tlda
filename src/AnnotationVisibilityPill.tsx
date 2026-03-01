/**
 * AnnotationVisibilityPill — presenter control for foreign annotation visibility.
 * Cycles: visible → faint → hidden.
 */
import { useState, useEffect, useRef, useSyncExternalStore } from 'react'
import {
  getVisibilityMode,
  setVisibilityMode,
  subscribeVisibility,
  type VisibilityMode,
} from './annotationVisibility'
import './AnnotationVisibilityPill.css'

const MODE_LABELS: Record<VisibilityMode, string> = {
  visible: 'Visible',
  faint: 'Faint',
  hidden: 'Hidden',
}

const MODE_ICONS: Record<VisibilityMode, string> = {
  visible: '\u{1F441}',  // eye
  faint: '\u25CC',        // dotted circle
  hidden: '\u2014',       // em dash
}

export function AnnotationVisibilityPill() {
  const [showPopup, setShowPopup] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const mode = useSyncExternalStore(subscribeVisibility, getVisibilityMode)

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

  return (
    <div className="annot-vis-container" ref={containerRef}>
      <span
        className="annot-vis-badge"
        onClick={() => setShowPopup(s => !s)}
        onPointerDown={e => e.stopPropagation()}
        title={`Others' annotations: ${MODE_LABELS[mode]}`}
      >
        {MODE_ICONS[mode]}
      </span>
      {showPopup && (
        <div
          className="annot-vis-popup"
          onPointerDown={e => e.stopPropagation()}
        >
          {(['visible', 'faint', 'hidden'] as VisibilityMode[]).map(m => (
            <div
              key={m}
              className={`annot-vis-option${mode === m ? ' active' : ''}`}
              onClick={() => { setVisibilityMode(m); setShowPopup(false) }}
            >
              <span>{MODE_ICONS[m]}</span>
              <span>{MODE_LABELS[m]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
