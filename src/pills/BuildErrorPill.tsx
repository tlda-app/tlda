/**
 * BuildErrorPill — LOUD, always-visible indicator that the last build FAILED.
 *
 * Build errors are also drawn on the canvas (BuildErrorOverlay) near the source
 * line, but that's easy to miss when scrolled elsewhere — and worthless if the
 * failure produced no resolvable line. This pill sits in the always-visible
 * build-pills-row and is deliberately loud (red, full opacity, visible label)
 * because a failed build is exactly the moment chrome should NOT be subtle.
 * Click to list the errors; each error with a line opens in the editor.
 */
import { useState, useEffect, useRef, useContext } from 'react'
import { DocContext } from '../PanelContext'
import { openInEditor } from '../texsync'
import type { BuildError } from '../useYjsSync'
import './BuildErrorPill.css'

interface BuildErrorPillProps {
  errors: BuildError[]
}

/** Strip the leading "! " / "! LaTeX Error: " noise for display. */
function cleanMessage(msg: string): string {
  return msg.replace(/^!\s*/, '').replace(/^LaTeX Error:\s*/i, '')
}

export function BuildErrorPill({ errors }: BuildErrorPillProps) {
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

  const handleCleanRebuild = async () => {
    if (!doc) return
    try {
      await fetch(`/api/projects/${doc.docName}/build?clean=1`, { method: 'POST' })
    } catch {}
    setShowList(false)
  }

  if (errors.length === 0) return null

  return (
    <div className="build-error-container" ref={containerRef}>
      <span
        className="build-error-badge"
        onClick={() => setShowList(s => !s)}
        onPointerDown={e => e.stopPropagation()}
        title={errors.length + ' build error' + (errors.length !== 1 ? 's' : '') + ' — the document may be incomplete'}
      >
        &#9888; {errors.length} build error{errors.length !== 1 ? 's' : ''}
      </span>
      {showList && (
        <div className="build-error-list" onPointerDown={e => e.stopPropagation()}>
          {errors.map((err, i) => {
            const hasLine = err.line != null
            return (
              <div
                key={i}
                className={'build-error-item' + (hasLine ? ' clickable' : '')}
                onClick={hasLine && doc ? () => openInEditor(doc.docName, err.file || '', err.line!) : undefined}
              >
                {hasLine && <span className="build-error-loc">{(err.file || '').split('/').pop()}:{err.line}</span>}
                {cleanMessage(err.message)}
              </div>
            )
          })}
          <div className="build-error-item clickable clean-rebuild" onClick={handleCleanRebuild}>
            &#8635; Clean rebuild
          </div>
        </div>
      )}
    </div>
  )
}
