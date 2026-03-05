/**
 * AnnotationVisibilityPill — controls visibility of others' annotations.
 * Icon: two stacked layers. Bottom (own) always filled. Top (others) fill = mode:
 *   visible → filled, faint → half-filled (clip), hidden → outline only.
 */
import { useState, useEffect, useRef, useSyncExternalStore } from 'react'
import {
  getVisibilityMode,
  setVisibilityMode,
  subscribeVisibility,
  type VisibilityMode,
} from '../annotationVisibility'
import './AnnotationVisibilityPill.css'

const MODE_LABELS: Record<VisibilityMode, string> = {
  visible: 'Visible',
  faint: 'Faint',
  hidden: 'Hidden',
}

function LayersIcon({ mode }: { mode: VisibilityMode }) {
  const id = `lc-${mode}`
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className="annot-vis-icon">
      {mode === 'faint' && (
        <defs>
          <clipPath id={id}>
            <rect x="4" y="1" width="4.5" height="8" />
          </clipPath>
        </defs>
      )}
      {/* bottom layer — own annotations, always filled */}
      <rect x="1" y="4" width="9" height="8" rx="1" fill="currentColor" opacity="0.9" />
      {/* top layer — others' annotations, fill = visibility mode */}
      {mode === 'visible' && (
        <rect x="4" y="1" width="9" height="8" rx="1" fill="currentColor" opacity="0.9" />
      )}
      {mode === 'faint' && (
        <>
          <rect x="4" y="1" width="9" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.7" />
          <rect x="4" y="1" width="9" height="8" rx="1" fill="currentColor" opacity="0.9" clipPath={`url(#${id})`} />
        </>
      )}
      {mode === 'hidden' && (
        <rect x="4" y="1" width="9" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.7" />
      )}
    </svg>
  )
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
        <LayersIcon mode={mode} />
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
              <LayersIcon mode={m} />
              <span>{MODE_LABELS[m]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
