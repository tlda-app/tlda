/**
 * BuildWarningPill — tiny warning icon with count.
 * Click to see the actual warnings. Each warning with a line number
 * is clickable to open in editor via texsync.
 */
import { useState, useEffect, useRef, useContext, useMemo } from 'react'
import { useEditor } from 'tldraw'
import type { TLShapeId } from 'tldraw'
import { DocContext } from '../PanelContext'
import { openInEditor } from '../texsync'
import type { BuildWarning } from '../useYjsSync'
import './BuildWarningPill.css'

interface BuildWarningPillProps {
  warnings: BuildWarning[]
  children?: React.ReactNode
}

/** Strip the LaTeX Warning: / Package ... Warning: prefix. */
function cleanMessage(msg: string): string {
  return msg.replace(/^LaTeX Warning:\s*|^Package \S+ Warning:\s*/i, '')
}

function dedupeWarnings(warnings: BuildWarning[]): BuildWarning[] {
  const seen = new Set<string>()
  const out: BuildWarning[] = []
  for (const warning of warnings) {
    const key = `${warning.category || ''}\0${warning.file || ''}\0${warning.line ?? ''}\0${warning.message}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(warning)
  }
  return out
}

export function BuildWarningPill({ warnings, children }: BuildWarningPillProps) {
  const editor = useEditor()
  const [sentinelWarnings, setSentinelWarnings] = useState<BuildWarning[]>([])
  const [showList, setShowList] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const doc = useContext(DocContext)

  // A build's warning state must survive reconnects and late-opening viewers.
  // The doc-version sentinel is convergent Yjs state; warning props are only
  // for transient non-build warnings such as annotation remap failures.
  useEffect(() => {
    if (!editor) return
    const read = (): BuildWarning[] => {
      const s = editor.store.get('shape:doc-version--sentinel' as TLShapeId)
      const json = (s as any)?.props?.warningsJson
      if (!json) return []
      try {
        const arr = JSON.parse(json)
        return Array.isArray(arr) ? arr.map(w => ({ ...w, category: w.category || 'tex' })) : []
      } catch {
        return []
      }
    }
    setSentinelWarnings(read())
    return editor.store.listen(() => setSentinelWarnings(read()), { scope: 'all' })
  }, [editor])

  const allWarnings = useMemo(
    () => dedupeWarnings([...sentinelWarnings, ...warnings]),
    [sentinelWarnings, warnings],
  )

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

  // Always render container (for children like BuildProgressPill even with 0 warnings)
  return (
    <div className="build-warning-container" ref={containerRef}>
      {allWarnings.length > 0 && (
        <span
          className="build-warning-badge"
          onClick={() => setShowList(s => !s)}
          onPointerDown={e => e.stopPropagation()}
          title={allWarnings.length + ' warning' + (allWarnings.length !== 1 ? 's' : '')}
        >&#9888;{allWarnings.length}</span>
      )}
      {children}
      {showList && (
        <div
          className="build-warning-list"
          onPointerDown={e => e.stopPropagation()}
        >
          {allWarnings.map((w, i) => {
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
          <div
            className="build-warning-item clickable clean-rebuild"
            onClick={handleCleanRebuild}
          >
            ↻ Clean rebuild
          </div>
        </div>
      )}
    </div>
  )
}
