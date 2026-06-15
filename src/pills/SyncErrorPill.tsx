/**
 * SyncErrorPill — enlarged sibling of BuildErrorPill for mirror/shadow sync
 * failures. A sync failure is more significant than a build error (the working
 * copy may be out of step with the build), so it surfaces as a LARGER badge in
 * the same pill row, same interaction: badge → click to expand the message(s).
 *
 * Single source of truth: reads `syncErrorJson` straight from the doc-version
 * sentinel shape (convergent Yjs state, survives reconnect). Set by the server
 * when a critical daemon-warning fires for this doc; cleared on the next clean
 * sync (daemon-sync-ok). Renders nothing when there's no standing sync failure.
 */
import { useState, useEffect, useRef } from 'react'
import { useEditor } from 'tldraw'
import type { TLShapeId } from 'tldraw'
import './SyncErrorPill.css'

interface SyncError { message?: string }

export function SyncErrorPill() {
  const editor = useEditor()
  const [errors, setErrors] = useState<SyncError[]>([])
  const [showList, setShowList] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!editor) return
    const read = (): SyncError[] => {
      const s = editor.store.get('shape:doc-version--sentinel' as TLShapeId)
      const json = (s as any)?.props?.syncErrorJson
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

  if (errors.length === 0) return null

  return (
    <div className="sync-error-container" ref={containerRef}>
      <span
        className="sync-error-badge"
        onClick={() => setShowList(s => !s)}
        onPointerDown={e => e.stopPropagation()}
        title="Mirror sync failed — your working copy may be out of step with the build"
      >&#9888; sync failed</span>
      {showList && (
        <div className="sync-error-list" onPointerDown={e => e.stopPropagation()}>
          <div className="sync-error-head">Mirror sync failed</div>
          {errors.map((err, i) => (
            <div key={i} className="sync-error-item">{String(err?.message ?? err)}</div>
          ))}
          <div className="sync-error-note">
            Your working copy may be out of step with the build. This clears automatically on the next clean sync.
          </div>
        </div>
      )}
    </div>
  )
}
