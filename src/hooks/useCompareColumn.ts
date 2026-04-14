/**
 * useCompareColumn — renders a second column of SVG pages from a shadow-repo
 * snapshot alongside the live document. The two columns are vertically
 * alignable via a draggable Y offset.
 *
 * Triggered by signal:compare { ref } or by the compare() MCP tool.
 * Destroyed by signal:compare { ref: null }.
 */
import { useEffect, useRef, useCallback } from 'react'
import { createShapeId, type Editor, type TLShapeId } from 'tldraw'
import { setSvgText, deleteSvgText, svgViewBoxStore } from '../stores'
import { TARGET_WIDTH, PAGE_GAP, PDF_WIDTH, PDF_HEIGHT } from '../layoutConstants'

const COMPARE_GAP = 80   // canvas px between live and comparison columns
// Use a session-unique prefix so create-delete-create doesn't collide
// with tldraw's undo stack retaining old IDs.
let compareSession = 0
const COMPARE_PREFIX = 'compare-page-'
function comparePrefix() { return `compare-page-${compareSession}-` }

/** Remove all comparison page shapes from the canvas. */
function clearCompareShapes(editor: Editor) {
  const toDelete = editor.getCurrentPageShapes()
    .filter(s => (s.id as string).includes(COMPARE_PREFIX))
  for (const s of toDelete) {
    deleteSvgText(s.id as string)
    if (s.isLocked) editor.updateShape({ id: s.id, type: s.type, isLocked: false })
  }
  if (toDelete.length > 0) editor.deleteShapes(toDelete.map(s => s.id))
}

/** Create comparison column shapes and fetch their SVGs. */
async function createCompareColumn(
  editor: Editor,
  docName: string,
  ref: string,
  pageCount: number,
) {
  const width = TARGET_WIDTH
  const height = PDF_HEIGHT * (TARGET_WIDTH / PDF_WIDTH)

  // Find the right edge of the existing document pages
  const existingPages = editor.getCurrentPageShapes()
    .filter(s => (s as any).type === 'svg-page' && !(s.id as string).includes(COMPARE_PREFIX))
  let rightEdge = 0
  for (const p of existingPages) {
    const b = editor.getShapePageBounds(p.id)
    if (b && b.x + b.w > rightEdge) rightEdge = b.x + b.w
  }
  const compareX = rightEdge + COMPARE_GAP

  // Create standalone page shapes (not grouped — tldraw groups don't
  // render children's component individually, so SVG injection fails).
  // Each page is locked at its absolute position. To drag the column,
  // select all and drag (or use layout mode).
  const prefix = comparePrefix()
  const shapes: Array<{ id: TLShapeId; shapeId: string }> = []
  let top = 0
  const shapeDefs = []
  for (let i = 0; i < pageCount; i++) {
    const shapeId = createShapeId(`${prefix}${i}`)
    shapes.push({ id: shapeId, shapeId: shapeId as string })
    shapeDefs.push({
      id: shapeId,
      type: 'svg-page' as any,
      x: compareX,
      y: top,
      isLocked: true,
      opacity: 0.85,
      props: { w: width, h: height, pageIndex: i },
    })
    top += height + PAGE_GAP
  }
  editor.createShapes(shapeDefs)

  // Create a drag handle between the columns — a thin vertical bar
  // that the user grabs to slide the comparison column. Dragging it
  // moves all compare pages. Vertical movement offsets the column;
  // horizontal movement adjusts the gap (with heavy vertical bias).
  const handleId = createShapeId(`${prefix}handle`)
  const handleH = Math.min(top, 2000) // visible portion
  editor.createShape({
    id: handleId,
    type: 'geo' as any,
    x: compareX - COMPARE_GAP / 2 - 8,  // centered in the gap
    y: 0,
    isLocked: false,
    opacity: 0.3,
    props: {
      w: 12,
      h: handleH,
      geo: 'rectangle',
      fill: 'solid',
      color: 'light-blue',
      dash: 'solid',
    },
  })

  // Fetch SVGs from shadow cache and inject into svgTextStore
  const hash7 = ref.slice(0, 7)
  const basePath = `/docs/${docName}/history/shadow-${hash7}/`
  console.log(`[compare] Fetching ${pageCount} pages from ${basePath}`)
  let fetched = 0, failed = 0
  for (let i = 0; i < pageCount; i++) {
    const url = `${basePath}page-${i + 1}.svg`
    try {
      const res = await fetch(url)
      if (!res.ok) { failed++; continue }
      const svgText = await res.text()
      // Parse viewBox
      const vbMatch = svgText.match(/viewBox="([^"]+)"/)
      if (vbMatch) {
        const parts = vbMatch[1].split(/\s+/).map(Number)
        if (parts.length === 4) {
          svgViewBoxStore.set(shapes[i].shapeId, {
            minX: parts[0], minY: parts[1],
            width: parts[2], height: parts[3],
          })
        }
      }
      setSvgText(shapes[i].shapeId, svgText)
      fetched++
    } catch {
      failed++
    }
  }
  console.log(`[compare] Done: ${fetched} fetched, ${failed} failed, ${shapes.length} shapes`)

  return { compareX, pageCount: shapes.length }
}

/**
 * Hook: listen for compare signals and manage the comparison column.
 * Call with the main editor and the current document info.
 */
export function useCompareColumn(
  _editor: Editor | null,  // unused — we read from window for freshness
  docName: string | null,
  pageCount: number,
) {
  const activeRef = useRef<string | null>(null)

  const startCompare = useCallback(async (ref: string) => {
    console.log(`[compare] startCompare called: ref=${ref}, docName=${docName}, pageCount=${pageCount}`)
    // Read editor from window to avoid stale ref capture.
    // If the editor isn't ready yet (signal fired before mount), retry
    // after a short delay. This handles the cached-signal-on-connect race.
    let editor = (window as any).__tldraw_editor__ as Editor | undefined
    if (!editor || !docName) {
      console.log(`[compare] editor/docName not ready, waiting 2s...`)
      await new Promise(r => setTimeout(r, 2000))
      editor = (window as any).__tldraw_editor__ as Editor | undefined
      if (!editor || !docName) {
        console.log(`[compare] GAVE UP: editor=${!!editor}, docName=${docName}`)
        return
      }
    }
    // If pageCount is 0 (doc not loaded yet), poll for shapes with retries
    let effectivePageCount = pageCount
    if (effectivePageCount === 0) {
      for (let retry = 0; retry < 10; retry++) {
        effectivePageCount = editor.getCurrentPageShapes()
          .filter(s => (s as any).type === 'svg-page' && !(s.id as string).includes('compare-page')).length
        if (effectivePageCount > 0) break
        console.log(`[compare] waiting for doc pages (attempt ${retry + 1}/10)...`)
        await new Promise(r => setTimeout(r, 1000))
      }
    }
    if (effectivePageCount === 0) {
      console.log(`[compare] ABORT: no pages found after retries`)
      return
    }
    console.log(`[compare] using ${effectivePageCount} pages`)

    // Clear any existing comparison and bump session for unique IDs
    clearCompareShapes(editor)
    compareSession++
    activeRef.current = ref

    await createCompareColumn(editor, docName, ref, effectivePageCount)
  }, [docName, pageCount])

  const stopCompare = useCallback(() => {
    const editor = (window as any).__tldraw_editor__ as Editor | undefined
    if (!editor) return
    clearCompareShapes(editor)
    activeRef.current = null
  }, [])

  // Listen for compare signal via custom event (dispatched by MCP tool handler)
  useEffect(() => {
    function onCompare(e: Event) {
      const detail = (e as CustomEvent).detail || {}
      // Signal bus wraps data as { key, data: { ref, ... }, timestamp }
      const ref = detail.ref || detail.data?.ref || null
      if (ref) startCompare(ref)
      else stopCompare()
    }
    window.addEventListener('tlda-compare', onCompare)
    return () => window.removeEventListener('tlda-compare', onCompare)
  }, [startCompare, stopCompare])

  // Store listener: when the handle shape is dragged, apply the delta
  // to all compare page shapes. Heavy vertical bias: only apply
  // horizontal movement if |dx| > 3 * |dy|.
  const handlePosRef = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => {
    // Re-run when _editor changes (initially null, then set by Tldraw mount)
    const editor = _editor || (window as any).__tldraw_editor__ as Editor | undefined
    if (!editor) return

    const unsub = editor.store.listen(({ changes }) => {
      for (const [, to] of Object.values(changes.updated)) {
        const rec = to as any
        if (rec.typeName !== 'shape') continue
        const idStr = rec.id as string
        if (!idStr.includes(COMPARE_PREFIX) || !idStr.includes('handle')) continue

        // Handle moved
        const prev = handlePosRef.current
        if (!prev) {
          handlePosRef.current = { x: rec.x, y: rec.y }
          return
        }
        const dx = rec.x - prev.x
        const dy = rec.y - prev.y
        handlePosRef.current = { x: rec.x, y: rec.y }

        if (Math.abs(dy) < 0.5 && Math.abs(dx) < 0.5) return

        // Vertical: always apply. Horizontal: only if strongly horizontal.
        const applyDx = Math.abs(dx) > Math.abs(dy) * 3 ? dx : 0

        // Defer mutations — tldraw doesn't allow store writes inside a listener
        setTimeout(() => {
          const comparePages = editor.getCurrentPageShapes().filter(s =>
            (s.id as string).includes(COMPARE_PREFIX) &&
            !(s.id as string).includes('handle') &&
            (s as any).type === 'svg-page'
          )
          if (comparePages.length === 0) return

          for (const s of comparePages) {
            if (s.isLocked) editor.updateShape({ id: s.id, type: s.type, isLocked: false })
          }
          editor.updateShapes(comparePages.map(s => ({
            id: s.id, type: s.type,
            x: s.x + applyDx,
            y: s.y + dy,
          })) as any)
          for (const s of comparePages) {
            editor.updateShape({ id: s.id, type: s.type, isLocked: true })
          }
        }, 0)
      }
    })

    return unsub
  }, [_editor])

  return { startCompare, stopCompare, active: activeRef.current }
}
