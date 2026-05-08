/**
 * useDividerDiff — triggers a word-level diff when the user draws a highlight
 * on the vertical column divider between the current and shadow history columns.
 *
 * Detection: a newly created highlight shape whose x-range overlaps the gap zone
 * between the two columns ([columnX - OLD_PAGE_GAP, columnX]).
 *
 * On hit:
 *  1. Recolor the trigger highlight to 'light-blue' (diff-active indicator, still erasable)
 *  2. POST /api/projects/:name/history/diff-region → server runs latexdiff, creates
 *     highlight shapes directly in the Yjs room, returns shapeIds
 *  3. Track shapeIds keyed by trigger shape id — erasing the trigger removes results
 */

import { useEffect, useRef } from 'react'
import type { Editor } from 'tldraw'
import { SCALE_FACTOR, TARGET_WIDTH, PDF_HEIGHT } from '../layoutConstants'

const OLD_PAGE_GAP = 48   // canvas units gap between main and shadow column

export function useDividerDiff(
  editorRef: React.MutableRefObject<Editor | null>,
  docName: string,
  activeHash: string | null,
  columnX: number,
  shadowYOffset = 0,
) {
  // Map: trigger shape id → result shape ids (for cascade delete)
  const resultMapRef = useRef<Map<string, string[]>>(new Map())

  useEffect(() => {
    if (!activeHash || !docName || !columnX) return
    const editor = editorRef.current
    if (!editor) return

    const hash7 = activeHash.slice(0, 7)
    // Compute actual gap: find right edge of main document pages
    const mainPages = editor.getCurrentPageShapes()
      .filter((s: any) => s.type === 'svg-page' && !((s.id as string).includes('col-')))
    let mainRightEdge = 0
    for (const p of mainPages) {
      const b = editor.getShapePageBounds(p.id)
      if (b && b.x + b.w > mainRightEdge) mainRightEdge = b.x + b.w
    }
    const gapLeft = mainRightEdge > 0 ? mainRightEdge : columnX - OLD_PAGE_GAP
    const gapRight = columnX
    const resultMap = resultMapRef.current

    // Expose test function for verification: window.__testDiff(pageNum) triggers diff directly
    ;(window as any).__testDiff = async (pageNum = 25) => {
      const allShapes = editor.getCurrentPageShapes() as any[]
      const mainShapes = allShapes.filter((s: any) => s.type === 'svg-page' && s.x < columnX - 100)
        .sort((a: any, b: any) => a.y - b.y)
      const ps = mainShapes.find((s: any) => s.props.pageIndex + 1 === pageNum)
      if (!ps) return { error: `page ${pageNum} not found` }
      const fakeBounds = { x: columnX - OLD_PAGE_GAP + 10, y: ps.y + ps.props.h * 0.4, w: 20, h: 40 }
      const fakeShape = { id: `shape:test-diff-${Date.now()}`, type: 'highlight' }
      await triggerDiff(editor, fakeShape, fakeBounds, docName, hash7, columnX, shadowYOffset, resultMap)
      return { ok: true, page: pageNum, bounds: fakeBounds }
    }

    const unsub = editor.store.listen(({ changes }) => {
      // Detect new highlight shapes drawn in the gap zone
      for (const record of Object.values(changes.added)) {
        const shape = record as any
        if (shape.type !== 'highlight') continue

        const bounds = editor.getShapePageBounds(shape.id as any)
        if (!bounds || bounds.w < 5) continue   // skip pen-down (zero-size) events

        // Does this shape's x-range overlap the gap zone?
        const shapeRight = bounds.x + bounds.w
        if (shapeRight < gapLeft - 20 || bounds.x > gapRight + 20) continue

        // It's a divider hit — trigger the diff (async, fire-and-forget)
        triggerDiff(editor, shape, bounds, docName, hash7, columnX, shadowYOffset, resultMap)
      }

      // Cascade delete: when a trigger highlight is erased, remove its result shapes.
      // Defer mutations — can't write inside a store listener (per PageColumn.handleUnsub).
      for (const id of Object.keys(changes.removed)) {
        const resultIds = resultMap.get(id)
        if (!resultIds) continue
        resultMap.delete(id)
        const toDelete = [...resultIds]
        setTimeout(() => {
          for (const rid of toDelete) {
            if (editor.getShape(rid as any)) editor.deleteShapes([rid as any])
          }
        }, 0)
      }
    })

    return unsub
  }, [editorRef, docName, activeHash, columnX, shadowYOffset])
}

async function triggerDiff(
  editor: Editor,
  shape: any,
  bounds: { x: number; y: number; w: number; h: number },
  docName: string,
  hash7: string,
  columnX: number,
  shadowYOffset: number,
  resultMap: Map<string, string[]>,
) {
  // Find main column page shapes to determine which page the highlight covers
  const mainShapes = (editor.getCurrentPageShapes() as any[])
    .filter((s: any) => s.type === 'svg-page' && s.x < columnX - TARGET_WIDTH / 2)
    .sort((a: any, b: any) => a.y - b.y)

  if (mainShapes.length === 0) return

  // Find which main page the highlight's y-range overlaps
  const hlTop = bounds.y
  const hlBottom = bounds.y + Math.max(bounds.h, 4) // at least 4px tall
  let targetPage: any = null
  for (const ps of mainShapes) {
    const psBottom = ps.y + ps.props.h
    if (ps.y <= hlBottom && psBottom >= hlTop) {
      targetPage = ps
      break
    }
  }
  if (!targetPage) return

  const pageNum: number = (targetPage.props as any).pageIndex + 1
  const pdfYMin = Math.max(0, (hlTop - targetPage.y) / SCALE_FACTOR)
  const pdfYMax = Math.min(PDF_HEIGHT, (hlBottom - targetPage.y) / SCALE_FACTOR)

  // Mark trigger as diff-active (teal color, still erasable).
  // Deferred: can't write to the store synchronously inside a store.listen callback.
  const shapeId = shape.id as any
  setTimeout(() => {
    if (editor.getShape(shapeId)) {
      editor.updateShape({ id: shapeId, type: 'highlight', props: { color: 'light-blue' } })
    }
  }, 0)

  try {
    const resp = await fetch(`/api/projects/${docName}/history/diff-region`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hash7, page: pageNum, pdfYMin, pdfYMax, columnX, shadowYOffset, triggerId: shape.id }),
    })
    if (!resp.ok) {
      console.warn('[diff-region] API error', resp.status)
      if (editor.getShape(shapeId)) {
        editor.updateShape({ id: shapeId, type: 'highlight', props: { color: 'violet' } })
      }
      return
    }

    // Server created highlight shapes directly in the Yjs room — just track the IDs
    const { shapeIds } = await resp.json() as { shapeIds: string[] }
    resultMap.set(shape.id as string, shapeIds ?? [])
  } catch (e) {
    console.error('[diff-region]', e)
    if (editor.getShape(shapeId)) {
      editor.updateShape({ id: shapeId, type: 'highlight', props: { color: 'violet' } })
    }
  }
}
