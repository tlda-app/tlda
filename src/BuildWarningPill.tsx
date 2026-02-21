/**
 * BuildWarningPill — tiny warning icon with count.
 * Click to see the actual warnings. Each warning with a line number
 * is clickable to open in editor via texsync.
 */
import { useState, useEffect, useRef, useContext } from 'react'
import { stopEventPropagation } from 'tldraw'
import { DocContext } from './PanelContext'
import { openInEditor } from './texsync'
import type { BuildWarning } from './useYjsSync'
import './BuildWarningPill.css'

interface BuildWarningPillProps {
  warnings: BuildWarning[]
}

/** Strip the LaTeX Warning: / Package natbib Warning: prefix. */
function cleanMessage(msg: string): string {
  return msg.replace(/^LaTeX Warning:\s*|^Package natbib Warning:\s*/i, '')
}

export function BuildWarningPill({ warnings }: BuildWarningPillProps) {
  const [showList, setShowList] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const doc = useContext(DocContext)

  useEffect(() => {
    if (!showList) return
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowList(false)
      }
    }
    document.addEventListener('pointerdown', handleClick, true)
    return () => document.removeEventListener('pointerdown', handleClick, true)
  }, [showList])

  if (warnings.length === 0) return null

  return (
    <div className="build-warning-container" ref={containerRef}>
      <span
        className="build-warning-badge"
        onClick={() => setShowList(s => !s)}
        onPointerDown={e => e.stopPropagation()}
        title={warnings.length + ' warning' + (warnings.length !== 1 ? 's' : '')}
      >&#9888;{warnings.length}</span>
      {showList && (
        <div
          className="build-warning-list"
          onPointerDown={e => e.stopPropagation()}
        >
          {warnings.map((w, i) => {
            const hasLine = w.line != null
            return (
              <div
                key={i}
                className={'build-warning-item' + (hasLine ? ' clickable' : '')}
                onClick={hasLine && doc ? () => openInEditor(doc.docName, w.file || '', w.line!) : undefined}
              >
                {cleanMessage(w.message)}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
