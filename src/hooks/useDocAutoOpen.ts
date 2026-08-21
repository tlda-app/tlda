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
import { TARGET_WIDTH } from '../layoutConstants'
import { setSvgText } from '../stores/svgTextStore'
import { svgViewBoxStore } from '../stores'
import { appendToken } from '../authToken'
import { loadDocumentFromManifest, type DocumentViewManifest } from '../loaders/documentLoaderRegistry'

const INBOX_GAP = 120  // gap between current doc and auto-opened docs
const FOREIGN_DOC_OPACITY = 0.85

interface DocArrivedEvent {
  type: 'doc-arrived'
  name: string
  title: string
  sourceFormat: string
  renderer: string
  documentFormat: string
  pages: number
  pageFiles: string[]
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
  projectName: string,
  onReloadRequest?: () => void,
) {
  const foreignDocsRef = useRef<Map<string, ForeignDoc>>(new Map())
  const [foreignDocNames, setForeignDocNames] = useState<string[]>([])

  const handleDocArrived = useCallback(async (event: DocArrivedEvent) => {
    const editor = editorRef.current
    if (!editor) return

    // Current doc updated — trigger reload
    if (event.name === projectName) {
      onReloadRequest?.()
      return
    }

    // Keep an existing document visible until its replacement has been fetched
    // and validated. A transient project/page-info failure is not a removal.
    const existing = foreignDocsRef.current.get(event.name)

    // Fetch project info to get page count and format
    let projectInfo: any
    try {
      const res = await fetch(`/api/projects/${event.name}`)
      if (!res.ok) return
      projectInfo = await res.json()
    } catch {
      return
    }

    const manifest = projectInfo.documentManifest as DocumentViewManifest | undefined
    if (!manifest) return
    const basePath = `/docs/${event.name}/`
    const foreignDocument = await loadDocumentFromManifest({ name: event.name, basePath, manifest })
    const htmlView = manifest.view.kind === 'html-pages' || manifest.view.kind === 'slides'
    const pageCount = foreignDocument.pages.length
    if (pageCount === 0) return

    if (existing) {
      editor.store.mergeRemoteChanges(() => {
        editor.store.remove([...existing.shapeIds, existing.labelId] as any)
      })
      foreignDocsRef.current.delete(event.name)
    }

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

    // Create shapes first (SVG pages show their loading state while fetched).
    const shapes: any[] = []
    for (let i = 0; i < pageCount; i++) {
      const id = createShapeId(`foreign-${event.name}-p${i + 1}`)
      const foreignPage = foreignDocument.pages[i]
      const width = foreignPage.width || TARGET_WIDTH
      const height = foreignPage.height || document.pages[0]?.bounds.height || 1035
      const separateCanvasPage = Boolean(foreignPage.tldrawPageId)
      const x = separateCanvasPage ? startX : startX + foreignPage.bounds.x
      const y = separateCanvasPage
        ? startY + foreignDocument.pages.slice(0, i).reduce((sum, page) => sum + page.height + 32, 0)
        : startY + foreignPage.bounds.y
      shapes.push({
        id,
        type: (htmlView ? 'html-page' : 'svg-page') as any,
        x,
        y,
        isLocked: true,
        opacity: FOREIGN_DOC_OPACITY,
        meta: { foreignDocumentPage: true },
        props: {
          w: width,
          h: height,
          ...(htmlView
            ? { url: foreignPage.src, source: '' }
            : { pageIndex: i }),
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

    if (htmlView || manifest.view.kind === 'image-pages') return

    // Fetch SVGs asynchronously — served at /docs/{name}/page-{n}.svg
    for (let i = 0; i < pageCount; i++) {
      const id = shapeIds[i]
      fetchForeignPage(event.name, i, id, basePath, manifest.pages[i]?.file)
    }
  }, [editorRef, document, projectName, onReloadRequest])

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
  pageFile?: string,
) {
  try {
    const url = `${basePath}${pageFile || `page-${pageIndex + 1}.svg`}`
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
