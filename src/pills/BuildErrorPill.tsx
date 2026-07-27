/**
 * BuildErrorPill — error sibling of BuildWarningPill.
 *
 * Single source of truth: reads the current build's errors straight from the
 * doc-version sentinel shape (errorsJson) in the Yjs store. NOT a fire-and-forget
 * signal — a build's error status is a stable property that must survive
 * reconnect/restart, so it lives in convergent Yjs state and the badge reads it
 * reactively. Same interaction as the warning pill: badge with count → click to
 * expand a clickable list; each error with a line opens in the editor. Persists
 * until the next build writes a clean (error-free) sentinel.
 */
import { useState, useEffect, useRef, useContext } from 'react'
import { useEditor } from 'tldraw'
import type { TLShapeId } from 'tldraw'
import { ProjectContext } from '../PanelContext'
import { openInEditor } from '../texsync'
import type { BuildError } from '../useYjsSync'
import './BuildErrorPill.css'

/** Strip the leading "! " / "! LaTeX Error: " noise for display. */
function cleanMessage(msg: string): string {
  return String(msg).split('\n')[0].replace(/^!\s*/, '').replace(/^LaTeX Error:\s*/i, '')
}

export function BuildErrorPill() {
  const editor = useEditor()
  const [errors, setErrors] = useState<BuildError[]>([])
  const [showList, setShowList] = useState(false)
  const [cleanRebuildError, setCleanRebuildError] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const doc = useContext(ProjectContext)

  // Read errors from the doc-version sentinel and re-read whenever it changes.
  useEffect(() => {
    if (!editor) return
    const read = (): BuildError[] => {
      const s = editor.store.get('shape:doc-version--sentinel' as TLShapeId)
      const json = (s as any)?.props?.errorsJson
      if (!json) return []
      try { const arr = JSON.parse(json); return Array.isArray(arr) ? arr : [] } catch { return [] }
    }
    setErrors(read())
    return editor.store.listen(() => setErrors(read()), { scope: 'all' })
  }, [editor])

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
      const res = await fetch(`/api/projects/${doc.projectName}/build?clean=1`, { method: 'POST' })
      if (!res.ok) throw new Error(`clean rebuild failed: ${res.status}`)
      setCleanRebuildError('')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setCleanRebuildError(message)
      return
    }
    setShowList(false)
  }

  if (errors.length === 0) return null

  return (
    <div className="build-error-container" ref={containerRef}>
      <span
        className="build-error-badge"
        onClick={() => setShowList(s => !s)}
        onPointerDown={e => e.stopPropagation()}
        title={errors.length + ' build error' + (errors.length !== 1 ? 's' : '')}
      >&#9888;{errors.length}</span>
      {showList && (
        <div className="build-error-list" onPointerDown={e => e.stopPropagation()}>
          {errors.map((err, i) => {
            const hasLine = err.line != null
            return (
              <div
                key={i}
                className={'build-error-item' + (hasLine ? ' clickable' : '')}
                onClick={hasLine && doc ? () => openInEditor(doc.projectName, err.file || '', err.line!) : undefined}
              >
                {hasLine && <span className="build-error-loc">{(err.file || '').split('/').pop()}:{err.line}</span>}
                {cleanMessage(err.message)}
              </div>
            )
          })}
          <div className="build-error-item clickable clean-rebuild" onClick={handleCleanRebuild}>
            &#8635; Clean rebuild
          </div>
          {cleanRebuildError && (
            <div className="build-error-item">
              Clean rebuild failed: {cleanRebuildError}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
