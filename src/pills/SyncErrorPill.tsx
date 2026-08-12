/**
 * SyncErrorPill — quiet sibling of BuildErrorPill for mirror/source sync
 * failures. Reads `syncErrorJson` from the doc-version sentinel so the state
 * survives reconnects and stays separate from build errors.
 */
import { useState, useEffect, useRef, useContext } from 'react'
import { useEditor } from 'tldraw'
import type { TLShapeId } from 'tldraw'
import { ProjectContext } from '../PanelContext'
import { isMyFleetShape } from '../shapes/fleet-utils'
import { dispatchFleetHudReset, dispatchFleetHudToggle } from '../wm/editor-host-bridge'
import { writeFleetHudExpanded } from '../wm/fleet-hud-state'
import './SyncErrorPill.css'

interface SyncError { message?: string; file?: string; kind?: 'source-conflict' | 'sync-error'; owner?: any }

export function SyncErrorPill() {
  const editor = useEditor()
  const [sentinelErrors, setSentinelErrors] = useState<SyncError[]>([])
  const [projectErrors, setProjectErrors] = useState<SyncError[]>([])
  const [showList, setShowList] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const doc = useContext(ProjectContext)
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
    if (!doc?.projectName) return
    let cancelled = false
    const read = async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(doc.projectName)}`)
        if (!res.ok) throw new Error(`project ${res.status}`)
        const info = await res.json()
        if (cancelled) return
        const conflicts = Array.isArray(info?.sourceSyncConflicts) ? info.sourceSyncConflicts : []
        if (conflicts.length === 0) {
          setProjectErrors([])
          return
        }
        const conflictErrors = conflicts.map((conflict: any) => ({
          kind: 'source-conflict' as const,
          file: conflict.file,
          owner: conflict.owner,
          message: `Git conflict: ${conflict.file}`,
        }))
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
  }, [doc?.projectName])

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
    writeFleetHudExpanded(true)
    dispatchFleetHudToggle({ expanded: true })
    dispatchFleetHudReset()
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
        className={'sync-error-badge' + (errors.some(e => e.kind === 'source-conflict') ? ' sync-error-badge-conflict' : '')}
        onClick={() => setShowList(s => !s)}
        onPointerDown={e => e.stopPropagation()}
        title="Source sync blocked"
      >⇄ sync</span>
      {showList && (
        <div className="sync-error-list" onPointerDown={e => e.stopPropagation()}>
          <div className="sync-error-head">
            {errors.some(e => e.kind === 'source-conflict') ? 'Source sync blocked' : 'Mirror sync failed'}
          </div>
          {errors.map((err, i) => (
            <div
              key={i}
              className={'sync-error-item' + (err.kind === 'source-conflict' ? ' clickable' : '')}
              onClick={err.kind === 'source-conflict' ? () => openConflictInSourceEditor(err.file) : undefined}
            >
              {String(err?.message ?? err)}
            </div>
          ))}
          <div className="sync-error-note">
            {errors.some(e => e.kind === 'source-conflict')
              ? 'Resolve the conflict markers, then push the resolved source through tlda.'
              : 'Your working copy may be out of step with the build. This clears automatically on the next clean sync.'}
          </div>
        </div>
      )}
    </div>
  )
}
