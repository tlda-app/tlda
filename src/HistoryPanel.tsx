/**
 * HistoryPanel: side-by-side view of a historical snapshot.
 *
 * Shows old SVGs alongside the current document. Scrolls in sync
 * with the main editor camera. Minimal v1 — static <img> elements,
 * no TLDraw copy-store.
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import type { Editor } from 'tldraw'
import { snapshotPageUrl } from './historyStore'
import type { HistoryEntry } from './historyStore'
import './HistoryPanel.css'

interface Props {
  docName: string
  entry: HistoryEntry
  totalPages: number
  pageHeight: number  // canvas height per page (including gap)
  editor: Editor
  onClose: () => void
}

export function HistoryPanel({ docName, entry, totalPages, pageHeight, editor, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [visiblePage, setVisiblePage] = useState(1)

  // Sync scroll with main editor camera
  useEffect(() => {
    const interval = setInterval(() => {
      const camera = editor.getCamera()
      const viewport = editor.getViewportScreenBounds()
      // Compute which page is at the center of the viewport
      const centerY = (-camera.y + viewport.height / 2 / camera.z)
      const page = Math.max(1, Math.min(totalPages, Math.floor(centerY / pageHeight) + 1))
      setVisiblePage(page)
    }, 100)
    return () => clearInterval(interval)
  }, [editor, totalPages, pageHeight])

  // Scroll the panel to show the visible page
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const pageEl = el.querySelector(`[data-page="${visiblePage}"]`)
    if (pageEl) {
      pageEl.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }, [visiblePage])

  // Compute which pages to render (visible ± 3 for smooth scrolling)
  const pagesToRender = useMemo(() => {
    const pages: number[] = []
    const snapshotPages = entry.pages ?? totalPages
    for (let i = Math.max(1, visiblePage - 3); i <= Math.min(snapshotPages, visiblePage + 3); i++) {
      pages.push(i)
    }
    return pages
  }, [visiblePage, totalPages, entry.pages])

  const label = entry.type === 'git'
    ? entry.commitMessage?.slice(0, 40) || entry.id
    : new Date(entry.timestamp).toLocaleTimeString()

  return (
    <div className="history-panel">
      <div className="history-panel-header">
        <span className="history-panel-label">{label}</span>
        <button className="history-panel-close" onClick={onClose}>×</button>
      </div>
      <div className="history-panel-pages" ref={containerRef}>
        {Array.from({ length: entry.pages ?? totalPages }, (_, i) => i + 1).map(page => (
          <div key={page} data-page={page} className="history-panel-page">
            {pagesToRender.includes(page) ? (
              <img
                src={snapshotPageUrl(docName, entry.id, page)}
                alt={`Page ${page}`}
                loading="lazy"
              />
            ) : (
              <div className="history-panel-placeholder">p.{page}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
