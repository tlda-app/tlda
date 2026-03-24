/**
 * useDocAutoOpen — listens for doc-arrived events from the server's global
 * event stream and auto-opens new documents on the canvas.
 *
 * When a new doc arrives via fleet push + build:
 *   - If it's the current doc: trigger a page reload (re-fetch SVGs)
 *   - If it's a different doc: create SvgPageShapes to the right of existing content
 *
 * Uses SSE (Server-Sent Events) via GET /api/projects/events/stream.
 */

import { useEffect, useRef, useCallback, useState } from 'react'
import { createShapeId } from 'tldraw'
import type { TLShapeId, Editor } from 'tldraw'
import type { SvgDocument } from '../svgDocumentLoader'
import { TARGET_WIDTH, PAGE_GAP } from '../layoutConstants'
import { setSvgText } from '../stores/svgTextStore'
import { svgViewBoxStore } from '../stores'
import { appendToken } from '../authToken'

const INBOX_GAP = 120  // gap between current doc and auto-opened docs
const FOREIGN_DOC_OPACITY = 0.85

interface DocArrivedEvent {
  type: 'doc-arrived'
  name: string
  title: string
  format: string
  pages: number
  timestamp: number
}

interface ForeignDoc {
  name: string
  shapeIds: TLShapeId[]
  labelId: TLShapeId
}

export function useDocAutoOpen(
  editorRef: React.MutableRefObject<Editor | null>,
  document: SvgDocument,
  docName: string,
  onReloadRequest?: () => void,
) {
  const foreignDocsRef = useRef<Map<string, ForeignDoc>>(new Map())
  const [foreignDocNames, setForeignDocNames] = useState<string[]>([])

  const handleDocArrived = useCallback(async (event: DocArrivedEvent) => {
    const editor = editorRef.current
    if (!editor) return

    // Current doc updated — trigger reload
    if (event.name === docName) {
      onReloadRequest?.()
      return
    }

    // Already on canvas — refresh (remove old shapes, re-fetch)
    const existing = foreignDocsRef.current.get(event.name)
    if (existing) {
      editor.store.mergeRemoteChanges(() => {
        editor.store.remove([...existing.shapeIds, existing.labelId] as any)
      })
      foreignDocsRef.current.delete(event.name)
    }

    // Fetch project info to get page count and format
    let projectInfo: any
    try {
      const res = await fetch(`/api/projects/${event.name}`)
      if (!res.ok) return
      projectInfo = await res.json()
    } catch {
      return
    }

    const pageCount = projectInfo.pages || event.pages || 0
    if (pageCount === 0) return

    // Determine position: to the right of all existing content
    let rightEdge = 0
    for (const shape of editor.getCurrentPageShapes()) {
      const right = shape.x + ((shape.props as any)?.w || 0)
      if (right > rightEdge) rightEdge = right
    }

    const startX = rightEdge + INBOX_GAP
    const startY = document.pages.length > 0 ? document.pages[0].bounds.y : 0

    // Fetch and create page shapes
    const shapeIds: TLShapeId[] = []

    // Create shapes first (they'll show loading state), then fetch SVGs
    const shapes: any[] = []
    for (let i = 0; i < pageCount; i++) {
      const id = createShapeId(`foreign-${event.name}-p${i + 1}`)
      const y = startY + i * (document.pages[0]?.bounds.height || 1035 + PAGE_GAP)
      shapes.push({
        id,
        type: 'svg-page' as any,
        x: startX,
        y,
        isLocked: true,
        opacity: FOREIGN_DOC_OPACITY,
        props: {
          w: TARGET_WIDTH,
          h: document.pages[0]?.bounds.height || 1035,
          pageIndex: i,
        },
      })
      shapeIds.push(id)
    }

    // Label above the doc
    const labelId = createShapeId(`foreign-${event.name}-label`)
    shapes.push({
      id: labelId,
      type: 'text' as any,
      x: startX,
      y: startY - 32,
      isLocked: true,
      opacity: 0.5,
      props: {
        richText: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: event.title || event.name }] }] },
        font: 'sans',
        size: 's',
        color: 'grey',
        scale: 1,
      },
    })

    editor.store.mergeRemoteChanges(() => {
      editor.createShapes(shapes)
    })

    // Track foreign doc
    foreignDocsRef.current.set(event.name, { name: event.name, shapeIds, labelId })
    setForeignDocNames([...foreignDocsRef.current.keys()])

    // Fetch SVGs asynchronously — served at /docs/{name}/page-{n}.svg
    const svgBasePath = `/docs/${event.name}/`
    for (let i = 0; i < pageCount; i++) {
      const id = shapeIds[i]
      fetchForeignPage(event.name, i, id, svgBasePath)
    }
  }, [editorRef, document, docName, onReloadRequest])

  // SSE connection
  useEffect(() => {
    const url = appendToken('/api/projects/events/stream')
    let es: EventSource | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    function connect() {
      es = new EventSource(url)

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          if (data.type === 'doc-arrived') {
            handleDocArrived(data as DocArrivedEvent)
          }
        } catch {}
      }

      es.onerror = () => {
        es?.close()
        // Retry after 5s
        retryTimer = setTimeout(connect, 5000)
      }
    }

    connect()

    return () => {
      es?.close()
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [handleDocArrived])

  return { foreignDocNames }
}

/** Fetch a single SVG page for a foreign document and inject it into the svgText store. */
async function fetchForeignPage(
  _docName: string,
  pageIndex: number,
  shapeId: TLShapeId,
  basePath: string,
) {
  try {
    const url = `${basePath}page-${pageIndex + 1}.svg`
    const res = await fetch(url)
    if (!res.ok) return
    const svgText = await res.text()

    // Parse viewBox
    const vbMatch = svgText.match(/viewBox="([^"]+)"/)
    if (vbMatch) {
      const parts = vbMatch[1].split(/\s+/).map(Number)
      if (parts.length === 4) {
        svgViewBoxStore.set(shapeId, {
          minX: parts[0], minY: parts[1],
          width: parts[2], height: parts[3],
        })
      }
    }

    // Inject SVG text — triggers SvgPageShape component re-render
    setSvgText(shapeId, svgText)
  } catch {
    // Silently ignore — page may not exist yet
  }
}
