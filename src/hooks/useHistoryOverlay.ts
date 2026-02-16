/**
 * useHistoryOverlay — places old SVGs from a history snapshot as inline
 * svg-page shapes to the left of current pages, with text coloring to
 * highlight changes on both sides.
 *
 * Old pages are loaded as SvgPageShapes (same as current pages) so they're
 * in the DOM and support CSS text coloring via the changeStore system.
 * No overlay rectangles needed — changed text is tinted directly.
 */

import { useState, useCallback, useRef } from 'react'
import { createShapeId, toRichText } from 'tldraw'
import type { TLShapeId, Editor } from 'tldraw'
import { snapshotPageUrl } from '../historyStore'
import type { PageDiff, ChangeItem } from '../historyStore'
import type { SvgDocument } from '../svgDocumentLoader'
import { TARGET_WIDTH } from '../layoutConstants'
import { svgTextStore, svgViewBoxStore, setChangeHighlights, dismissAllChanges } from '../SvgPageShape'
import type { ChangeRegion } from '../SvgPageShape'

const OLD_PAGE_GAP = 48

// Colors for text tinting
const NEW_TINT = '#1d4ed8'  // blue for new/changed text
const OLD_TINT = '#dc2626'  // red for old/removed text

interface OverlayState {
  shapeIds: Set<TLShapeId>
  highlightedShapeIds: string[]  // shapeIds we set change highlights on (for cleanup)
}

export function useHistoryOverlay(
  editorRef: React.MutableRefObject<Editor | null>,
  document: SvgDocument,
  shapeIdSetRef: React.MutableRefObject<Set<TLShapeId>>,
  shapeIdsArrayRef: React.MutableRefObject<TLShapeId[]>,
  updateCameraBoundsRef: React.MutableRefObject<((bounds: any) => void) | null>,
) {
  const [overlayActive, setOverlayActive] = useState(false)
  const overlayRef = useRef<OverlayState | null>(null)

  const showOverlay = useCallback(async (
    docName: string,
    snapshotId: string,
    changedPages: PageDiff[],
  ) => {
    const editor = editorRef.current
    if (!editor || changedPages.length === 0) return

    // Clean up any existing overlay first
    if (overlayRef.current) {
      removeOverlay(editor, overlayRef.current, shapeIdSetRef, shapeIdsArrayRef)
      overlayRef.current = null
    }

    const createdIds = new Set<TLShapeId>()
    const highlightedShapeIds: string[] = []

    // Build lookup of changes by page number
    const changesByPage = new Map<number, ChangeItem[]>()
    for (const pd of changedPages) {
      if (pd.changes && pd.changes.length > 0) {
        changesByPage.set(pd.page, pd.changes)
      } else if (pd.regions && pd.regions.length > 0) {
        changesByPage.set(pd.page, pd.regions.map((r, i) => ({
          id: `${pd.page}-${i}`, page: pd.page, y: r.y, height: r.height,
          x: r.x, width: r.width,
        })))
      }
    }

    // Fetch old SVGs from the snapshot
    const totalPages = document.pages.length
    const oldPages: Array<{
      pageNum: number
      svgText: string
      width: number
      height: number
      viewBox: { minX: number; minY: number; width: number; height: number }
    }> = []

    await Promise.all(
      Array.from({ length: totalPages }, (_, i) => i + 1).map(async (pageNum) => {
        const url = snapshotPageUrl(docName, snapshotId, pageNum)
        try {
          const resp = await fetch(url)
          if (!resp.ok) return
          const svgText = await resp.text()
          const dims = parseSvgDimensions(svgText)
          oldPages.push({ pageNum, svgText, ...dims })
        } catch {
          // skip pages that fail to load
        }
      })
    )

    if (oldPages.length === 0) return
    oldPages.sort((a, b) => a.pageNum - b.pageNum)

    editor.store.mergeRemoteChanges(() => {
      for (const op of oldPages) {
        const currentPage = document.pages[op.pageNum - 1]
        if (!currentPage) continue

        const shapeId = createShapeId(`${docName}-hist-old-${op.pageNum}`)

        // Scale old page to match current page width
        const scale = TARGET_WIDTH / op.width
        const displayW = TARGET_WIDTH
        const displayH = op.height * scale

        // Position to the left of current page
        const oldX = currentPage.bounds.x - displayW - OLD_PAGE_GAP
        const oldY = currentPage.bounds.y

        // Store SVG text and viewBox for SvgPageShape rendering
        svgTextStore.set(shapeId, op.svgText)
        svgViewBoxStore.set(shapeId, op.viewBox)

        // Create as svg-page shape (inline DOM, supports text coloring)
        editor.createShapes([{
          id: shapeId,
          type: 'svg-page' as any,
          x: oldX,
          y: oldY,
          isLocked: true,
          opacity: 1,
          props: {
            w: displayW,
            h: displayH,
            version: 0,
          },
        }])
        createdIds.add(shapeId)

        // Label above old page
        const labelId = createShapeId(`${docName}-hist-label-${op.pageNum}`)
        editor.createShapes([{
          id: labelId,
          type: 'text',
          x: oldX,
          y: oldY - 26,
          isLocked: true,
          opacity: 0.3,
          props: {
            richText: toRichText(`Old p.${op.pageNum}`),
            font: 'sans',
            size: 's',
            color: 'grey',
            scale: 0.8,
          },
        }])
        createdIds.add(labelId)

        // Set text coloring via changeStore
        const changes = changesByPage.get(op.pageNum)
        if (changes) {
          // New (current) side — blue tinted text
          const currentShapeId = currentPage.shapeId as string
          const newRegions: ChangeRegion[] = changes
            .filter(c => c.newLines && c.newLines.length > 0)
            .flatMap(c => c.newLines!.map(l => ({
              y: l.y, height: l.height, x: l.x, width: l.width,
              tint: NEW_TINT,
            })))
          // Also include bounding box for changes without per-line data
          for (const c of changes) {
            if ((!c.newLines || c.newLines.length === 0) && c.y != null && c.height != null) {
              newRegions.push({ y: c.y, height: c.height, x: c.x, width: c.width, tint: NEW_TINT })
            }
          }
          if (newRegions.length > 0) {
            setChangeHighlights(currentShapeId, newRegions)
            highlightedShapeIds.push(currentShapeId)
          }

          // Old side — red tinted text
          const oldRegions: ChangeRegion[] = changes
            .filter(c => c.oldLines && c.oldLines.length > 0)
            .flatMap(c => c.oldLines!.map(l => ({
              y: l.y, height: l.height, x: l.x, width: l.width,
              tint: OLD_TINT,
            })))
          if (oldRegions.length > 0) {
            setChangeHighlights(shapeId as string, oldRegions)
            highlightedShapeIds.push(shapeId as string)
          }
        }
      }
    })

    // Track overlay state
    overlayRef.current = { shapeIds: createdIds, highlightedShapeIds }
    for (const id of createdIds) {
      shapeIdSetRef.current.add(id)
      shapeIdsArrayRef.current.push(id)
    }

    // Expand camera bounds to include old pages
    if (updateCameraBoundsRef.current) {
      const allBounds = document.pages.reduce(
        (acc, page) => acc.union(page.bounds),
        document.pages[0].bounds.clone()
      )
      for (const op of oldPages) {
        const currentPage = document.pages[op.pageNum - 1]
        if (!currentPage) continue
        const oldX = currentPage.bounds.x - TARGET_WIDTH - OLD_PAGE_GAP
        if (oldX < allBounds.x) {
          const diff = allBounds.x - oldX
          allBounds.x = oldX
          allBounds.w += diff
        }
      }
      updateCameraBoundsRef.current(allBounds)
    }

    setOverlayActive(true)
  }, [document, editorRef, shapeIdSetRef, shapeIdsArrayRef, updateCameraBoundsRef])

  const hideOverlay = useCallback(() => {
    const editor = editorRef.current
    if (!editor || !overlayRef.current) return

    removeOverlay(editor, overlayRef.current, shapeIdSetRef, shapeIdsArrayRef)
    overlayRef.current = null

    // Restore camera bounds
    if (updateCameraBoundsRef.current) {
      const currentBounds = document.pages.reduce(
        (acc, page) => acc.union(page.bounds),
        document.pages[0].bounds.clone()
      )
      updateCameraBoundsRef.current(currentBounds)
    }

    setOverlayActive(false)
  }, [document, editorRef, shapeIdSetRef, shapeIdsArrayRef, updateCameraBoundsRef])

  const toggleOverlay = useCallback((
    docName: string,
    snapshotId: string,
    changedPages: PageDiff[],
  ) => {
    if (overlayRef.current) {
      hideOverlay()
    } else {
      showOverlay(docName, snapshotId, changedPages)
    }
  }, [showOverlay, hideOverlay])

  return { overlayActive, showOverlay, hideOverlay, toggleOverlay }
}

function removeOverlay(
  editor: Editor,
  state: OverlayState,
  shapeIdSetRef: React.MutableRefObject<Set<TLShapeId>>,
  shapeIdsArrayRef: React.MutableRefObject<TLShapeId[]>,
) {
  // Clear text tinting
  for (const sid of state.highlightedShapeIds) {
    setChangeHighlights(sid, [])
  }

  // Remove TLDraw shapes
  const allIds = [...state.shapeIds] as any[]
  editor.store.mergeRemoteChanges(() => {
    editor.store.remove(allIds)
  })

  // Clean up svgTextStore entries for old pages
  for (const id of state.shapeIds) {
    svgTextStore.delete(id)
    svgViewBoxStore.delete(id)
    shapeIdSetRef.current.delete(id)
  }
  shapeIdsArrayRef.current = shapeIdsArrayRef.current.filter(id => !state.shapeIds.has(id))
}

function parseSvgDimensions(svgText: string): {
  width: number; height: number
  viewBox: { minX: number; minY: number; width: number; height: number }
} {
  const vbMatch = svgText.match(/viewBox="([^"]+)"/)
  if (vbMatch) {
    const parts = vbMatch[1].split(/[\s,]+/).map(Number)
    if (parts.length === 4) {
      return {
        width: parts[2],
        height: parts[3],
        viewBox: { minX: parts[0], minY: parts[1], width: parts[2], height: parts[3] },
      }
    }
  }
  const wMatch = svgText.match(/width="([\d.]+)/)
  const hMatch = svgText.match(/height="([\d.]+)/)
  const w = wMatch ? parseFloat(wMatch[1]) : 612
  const h = hMatch ? parseFloat(hMatch[1]) : 792
  return { width: w, height: h, viewBox: { minX: 0, minY: 0, width: w, height: h } }
}
