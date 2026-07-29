/**
 * useTimelineOverlay — fetches timeline data from edit-events + annotation history,
 * creates/removes the TimelineOverlayShape on toggle.
 *
 * Data sources:
 *   1. GET /api/projects/{name}/history/edit-events — canonical source edit events
 *   2. GET /api/projects/{name}/shapes — current annotation shapes with createdAt meta
 *
 * Positions the timeline shape to the right of the document pages.
 */

import { useState, useCallback, useRef } from 'react'
import { createShapeId } from 'tldraw'
import type { TLShapeId, Editor } from 'tldraw'
import type { SvgDocument } from '../svgDocumentLoader'
import type { TimelineData, TimelineEvent, TimelineSection } from '../shapes/TimelineOverlayShape'
// TARGET_WIDTH import removed (unused)

const TIMELINE_GAP = 64  // gap between doc right edge and timeline

export function useTimelineOverlay(
  editorRef: React.MutableRefObject<Editor | null>,
  document: SvgDocument,
  projectName: string,
) {
  const [active, setActive] = useState(false)
  const shapeIdRef = useRef<TLShapeId | null>(null)

  const show = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) return

    // Fetch data from both endpoints concurrently
    const [historyRes, shapesRes] = await Promise.all([
      fetch(`/api/projects/${projectName}/history/edit-events`).then(r => r.ok ? r.json() : { events: [] }).catch(() => ({ events: [] })),
      fetch(`/api/projects/${projectName}/shapes`).then(r => r.ok ? r.json() : []).catch(() => []),
    ])

    const totalPages = document.pages.length
    const events: TimelineEvent[] = []

    // Process canonical edit-event history entries
    const historyEntries = historyRes.events || []
    for (const entry of historyEntries) {
      if (!entry.timestamp) continue

      const changedPages = entry.changed_pages || []
      const primaryPage = changedPages.length > 0 ? Math.min(...changedPages) : 1
      const significance = Math.min(1, (changedPages.length || 1) / Math.max(totalPages, 1))
      const actor = entry.actor_display_name || entry.actor_id || entry.origin || 'Edit'

      events.push({
        ts: entry.timestamp,
        type: 'build',
        page: primaryPage,
        pages: changedPages.length > 0 ? changedPages : [primaryPage],
        significance,
        label: `${actor}: ${changedPages.length || '?'} page(s) changed`,
        buildHash: entry.after_shadow_revision || entry.event_id,
      })
    }

    // Process annotation shapes — extract creation timestamps from meta
    const annotationTypes = new Set(['math-note', 'highlight', 'draw', 'arrow', 'text', 'note'])
    const shapes = Array.isArray(shapesRes) ? shapesRes : (shapesRes.records || [])
    for (const shape of shapes) {
      if (!annotationTypes.has(shape.type)) continue
      const createdAt = shape.meta?.createdAt
      if (!createdAt) continue

      // Determine which page this annotation is on based on Y position
      const page = getPageForY(shape.y, document)

      const typeMap: Record<string, 'annotation' | 'highlight' | 'comment'> = {
        'math-note': 'comment',
        'highlight': 'highlight',
        'draw': 'annotation',
        'arrow': 'annotation',
        'text': 'annotation',
        'note': 'comment',
      }

      events.push({
        ts: createdAt,
        type: typeMap[shape.type] || 'annotation',
        page,
        significance: 0.2,
        label: shape.type === 'math-note'
          ? `Note on p.${page}`
          : `${shape.type} on p.${page}`,
      })
    }

    if (events.length === 0) {
      // Nothing to show — still create the shape so user sees "no events"
    }

    // Compute time range
    const timestamps = events.map(e => e.ts).filter(t => t > 0)
    const timeRange = timestamps.length > 0
      ? { min: Math.min(...timestamps), max: Math.max(...timestamps) }
      : { min: Date.now() - 86400_000, max: Date.now() }

    // Build section labels from document page structure
    // For now, use page numbers as section markers (every 5 pages or so)
    const sections: TimelineSection[] = []
    const step = Math.max(1, Math.ceil(totalPages / 8))
    for (let p = 1; p <= totalPages; p += step) {
      sections.push({ label: `p.${p}`, startPage: p })
    }

    const timelineData: TimelineData = {
      events,
      sections,
      totalPages,
      timeRange,
    }

    // Position: to the right of the rightmost page
    const pageShapes = editor.getCurrentPageShapes().filter(
      (s: any) => s.type === 'svg-page' || s.type === 'html-page'
    )
    let rightEdge = 0
    for (const ps of pageShapes) {
      const right = ps.x + (ps.props as any).w
      if (right > rightEdge) rightEdge = right
    }
    const topY = document.pages.length > 0 ? document.pages[0].bounds.y : 0

    // Create shape
    const id = createShapeId(`${projectName}-timeline`)
    editor.store.mergeRemoteChanges(() => {
      editor.createShapes([{
        id,
        type: 'timeline-overlay' as any,
        x: rightEdge + TIMELINE_GAP,
        y: topY,
        isLocked: false,
        props: {
          w: 520,
          h: Math.min(500, Math.max(300, totalPages * 30 + 80)),
        },
        meta: {
          timelineData: timelineData as any,
        },
      }])
    })

    shapeIdRef.current = id
    setActive(true)
  }, [editorRef, document, projectName])

  const hide = useCallback(() => {
    const editor = editorRef.current
    if (!editor || !shapeIdRef.current) return

    editor.store.mergeRemoteChanges(() => {
      editor.store.remove([shapeIdRef.current!] as any)
    })
    shapeIdRef.current = null
    setActive(false)
  }, [editorRef])

  const toggle = useCallback(() => {
    if (active) {
      hide()
    } else {
      show()
    }
  }, [active, show, hide])

  return { timelineActive: active, toggleTimeline: toggle }
}

/** Determine which page number (1-indexed) a Y coordinate falls on. */
function getPageForY(y: number, document: SvgDocument): number {
  for (let i = 0; i < document.pages.length; i++) {
    const page = document.pages[i]
    if (y >= page.bounds.y && y < page.bounds.y + page.bounds.height) {
      return i + 1
    }
  }
  // Default to closest page
  let best = 1
  let bestDist = Infinity
  for (let i = 0; i < document.pages.length; i++) {
    const mid = document.pages[i].bounds.y + document.pages[i].bounds.height / 2
    const dist = Math.abs(y - mid)
    if (dist < bestDist) {
      bestDist = dist
      best = i + 1
    }
  }
  return best
}
