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
import { useState, useEffect, useRef, useContext } from 'react'
import { useEditor } from 'tldraw'
import type { TLShapeId } from 'tldraw'
import { DocContext } from '../PanelContext'
import { isMyFleetShape } from '../shapes/fleet-utils'
import './SyncErrorPill.css'

interface SyncError { message?: string; file?: string; kind?: 'overleaf-conflict' | 'sync-error' }

export function SyncErrorPill() {
  const editor = useEditor()
  const [sentinelErrors, setSentinelErrors] = useState<SyncError[]>([])
  const [projectErrors, setProjectErrors] = useState<SyncError[]>([])
  const [showList, setShowList] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const doc = useContext(DocContext)
  const errors = [...projectErrors, ...sentinelErrors]

  useEffect(() => {
    if (!editor) return
    const read = (): SyncError[] => {
      const s = editor.store.get('shape:doc-version--sentinel' as TLShapeId)
      const json = (s as any)?.props?.syncErrorJson
      if (!json) return []
      try { const arr = JSON.parse(json); return Array.isArray(arr) ? arr : [] } catch { return [] }
    }
    setSentinelErrors(read())
    return editor.store.listen(() => setSentinelErrors(read()), { scope: 'all' })
  }, [editor])

  useEffect(() => {
    if (!doc?.docName) return
    let cancelled = false
    const read = async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(doc.docName)}`)
        if (!res.ok) throw new Error(`project ${res.status}`)
        const info = await res.json()
        if (cancelled) return
        if (info?.overleafSyncStatus !== 'conflict') {
          setProjectErrors([])
          return
        }
        const files = Array.isArray(info?.overleafConflictFiles) ? info.overleafConflictFiles : []
        const conflictErrors = files.length > 0
          ? files.map((file: string) => ({
              kind: 'overleaf-conflict' as const,
              file,
              message: `Git conflict: ${file}`,
            }))
          : [{
              kind: 'overleaf-conflict' as const,
              message: 'Git conflict',
            }]
        setProjectErrors(conflictErrors)
      } catch {
        if (!cancelled) setProjectErrors([])
      }
    }
    void read()
    const interval = window.setInterval(read, 5000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [doc?.docName])

  const openConflictInSourceEditor = (file?: string) => {
    if (!file) return
    const sourceEditor = editor.getCurrentPageShapes()
      .find((shape: any) => shape.type === 'fleet-source-editor' && isMyFleetShape(shape)) as any
    if (!sourceEditor) {
      setShowList(false)
      return
    }
    editor.updateShape({
      id: sourceEditor.id,
      type: sourceEditor.type,
      props: { file, title: file, line: 1 },
    } as any)
    localStorage.setItem('fleet-hud-expanded', '1')
    window.dispatchEvent(new CustomEvent('fleet-hud-toggle', { detail: { expanded: true } }))
    window.dispatchEvent(new CustomEvent('fleet-hud-reset'))
    setShowList(false)
  }

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
        className={'sync-error-badge' + (errors.some(e => e.kind === 'overleaf-conflict') ? ' sync-error-badge-conflict' : '')}
        onClick={() => setShowList(s => !s)}
        onPointerDown={e => e.stopPropagation()}
        title="Source sync blocked"
      >&#9888; {errors.find(e => e.kind === 'overleaf-conflict')?.message || 'sync failed'}</span>
      {showList && (
        <div className="sync-error-list" onPointerDown={e => e.stopPropagation()}>
          <div className="sync-error-head">
            {errors.some(e => e.kind === 'overleaf-conflict') ? 'Source sync blocked' : 'Mirror sync failed'}
          </div>
          {errors.map((err, i) => (
            <div
              key={i}
              className={'sync-error-item' + (err.kind === 'overleaf-conflict' ? ' clickable' : '')}
              onClick={err.kind === 'overleaf-conflict' ? () => openConflictInSourceEditor(err.file) : undefined}
            >
              {String(err?.message ?? err)}
            </div>
          ))}
          <div className="sync-error-note">
            {errors.some(e => e.kind === 'overleaf-conflict')
              ? 'Resolve the conflict markers, then push the resolved source through tlda.'
              : 'Your working copy may be out of step with the build. This clears automatically on the next clean sync.'}
          </div>
        </div>
      )}
    </div>
  )
}
