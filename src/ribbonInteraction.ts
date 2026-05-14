/**
 * Ribbon interaction — converts highlights drawn in the left-margin ribbon zone
 * into understanding-line shapes instead of text highlights.
 *
 * The ribbon zone is x < 0 in canvas/page space (left of the document pages).
 * When the user highlights in this zone, the highlight is consumed and a
 * corresponding understanding-line shape is created/updated.
 *
 * Eraser in the ribbon zone resets segments to 'unchecked' instead of deleting.
 */

import type { Editor, TLShapeId } from 'tldraw'
import { loadLookup } from './synctexLookup'
import { pdfToCanvas } from './synctexAnchor'
import { getHumanId, getHumanName } from './fleet/fleet-data.mjs'
import { HIGHLIGHT_TO_STATUS } from './shapes/UnderstandingLineShape'
import type { SvgPage } from './loaders/types'

const MARGIN_X = -12
const BAR_WIDTH = 3

// Cache: docName → sorted [{line, canvasY}] for reverse lookup
const lineYIndexCache = new Map<string, Array<{ line: number; canvasY: number }>>()

async function getLineYIndex(docName: string, pages: SvgPage[]): Promise<Array<{ line: number; canvasY: number }>> {
  if (lineYIndexCache.has(docName)) return lineYIndexCache.get(docName)!

  const lookup = await loadLookup(docName)
  if (!lookup) return []

  const result: Array<{ line: number; canvasY: number }> = []
  for (const [key, entry] of Object.entries(lookup.lines)) {
    const lineNum = parseInt(key.includes(':') ? key.split(':')[1] : key, 10)
    if (isNaN(lineNum)) continue
    const canvas = pdfToCanvas(entry.page, entry.x, entry.y, pages.map(p => ({
      bounds: { x: p.bounds.x, y: p.bounds.y, width: p.bounds.w, height: p.bounds.h },
      width: p.width,
      height: p.height,
    })))
    if (canvas) result.push({ line: lineNum, canvasY: canvas.y })
  }
  result.sort((a, b) => a.canvasY - b.canvasY)
  lineYIndexCache.set(docName, result)
  return result
}

function findClosestLine(index: Array<{ line: number; canvasY: number }>, targetY: number): number | null {
  if (index.length === 0) return null
  let lo = 0, hi = index.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (index[mid].canvasY < targetY) lo = mid + 1
    else hi = mid
  }
  const candidates = [lo > 0 ? index[lo - 1] : null, index[lo]].filter((x): x is { line: number; canvasY: number } => x != null)
  return candidates.sort((a, b) => Math.abs(a.canvasY - targetY) - Math.abs(b.canvasY - targetY))[0]?.line ?? null
}

/**
 * Process a highlight drawn in the ribbon zone (bounds.maxX < 5 canvas units).
 * Creates/updates understanding-line shapes and removes the highlight.
 */
export async function processRibbonHighlight(
  editor: Editor,
  shapeId: TLShapeId,
  docName: string,
  pages: SvgPage[]
): Promise<void> {
  const shape = editor.getShape(shapeId)
  if (!shape) return

  const bounds = editor.getShapePageBounds(shapeId)
  if (!bounds) return

  const hlColor = (shape.props as any).color || 'green'
  const status = HIGHLIGHT_TO_STATUS[hlColor]

  editor.deleteShape(shapeId)

  if (!status) return

  const userId = getHumanId() || 'unknown'
  const displayName = getHumanName() || userId

  const x = MARGIN_X
  const h = Math.max(20, bounds.maxY - bounds.minY)

  const index = await getLineYIndex(docName, pages)
  const startLine = findClosestLine(index, bounds.minY) ?? 0
  const endLine = findClosestLine(index, bounds.maxY) ?? 0

  const uid = userId.replace(/[^a-zA-Z0-9]/g, '')
  const newShapeId = `shape:umap-${uid}-${startLine}-${endLine}` as TLShapeId

  const existing = editor.getShape(newShapeId)
  if (existing) {
    editor.updateShape({ id: newShapeId, type: 'understanding-line' as any, props: { ...(existing.props as any), status } })
  } else {
    editor.createShape({
      id: newShapeId,
      type: 'understanding-line' as any,
      x,
      y: bounds.minY,
      rotation: 0,
      isLocked: false,
      opacity: 1,
      props: { w: BAR_WIDTH, h, userId, displayName, startLine, endLine, status, userIndex: 0 },
    })
  }
}

/** Returns true if a highlight shape is in the ribbon zone (left margin) */
export function isInRibbonZone(editor: Editor, shapeId: TLShapeId): boolean {
  const bounds = editor.getShapePageBounds(shapeId)
  if (!bounds) return false
  return bounds.maxX < 5
}

/**
 * Register an after-delete handler that re-creates understanding-line shapes
 * as 'unchecked' when the eraser tool deletes them.
 * Call once from editorSetup.
 */
export function registerEraserInterceptor(editor: Editor): void {
  editor.sideEffects.registerAfterDeleteHandler('shape', (shape) => {
    if (shape.type !== 'understanding-line') return
    if (editor.getCurrentToolId() !== 'eraser') return

    // Re-create as unchecked after the deletion transaction completes
    setTimeout(() => {
      editor.createShape({
        id: shape.id as TLShapeId,
        type: 'understanding-line' as any,
        x: shape.x,
        y: shape.y,
        rotation: shape.rotation ?? 0,
        isLocked: false,
        opacity: 1,
        props: { ...(shape.props as any), status: 'unchecked' },
      })
    }, 0)
  })
}
