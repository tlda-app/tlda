/**
 * Ribbon interaction — converts highlights drawn in the left-margin ribbon zone
 * into understanding-line shapes instead of text highlights.
 *
 * The ribbon zone is x < 0 in canvas/page space (left of the document pages).
 * When the user highlights in this zone, the highlight is consumed and a
 * corresponding understanding-line shape is created/updated/deleted.
 */

import type { Editor, TLShapeId } from 'tldraw'
import { loadLookup } from './synctexLookup'
import { pdfToCanvas } from './synctexAnchor'
import { getHumanId, getHumanName } from './fleet/fleet-data.mjs'
import type { SvgPage } from './loaders/types'

// Colors that map to understanding-line statuses (null = delete)
const COLOR_TO_STATUS: Record<string, string | null | undefined> = {
  'light-green': 'approved',
  'green': 'approved',
  'yellow': 'understood',
  'orange': 'understood',
  'light-red': null,
  'red': null,
  // undefined for anything else = no action
}

const MARGIN_X = -12
const BAR_WIDTH = 3
const USER_GAP = 4

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
 * Creates/updates/deletes understanding-line shapes and removes the highlight.
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
  const status = COLOR_TO_STATUS[hlColor]

  // Consume the highlight shape
  editor.deleteShape(shapeId)

  if (status === undefined) return  // unmapped color, no action

  const userId = getHumanId() || 'unknown'
  const displayName = getHumanName() || userId

  const allUL = editor.getCurrentPageShapes().filter((s: any) => s.type === 'understanding-line')

  if (status === null) {
    // Delete all understanding lines for this user overlapping this Y range
    const toDelete = allUL
      .filter((s: any) => s.props?.userId === userId && s.y < bounds.maxY && s.y + (s.props.h ?? 0) > bounds.minY)
      .map((s: any) => s.id as TLShapeId)
    if (toDelete.length > 0) editor.deleteShapes(toDelete)
    return
  }

  // Determine stacking index for this user
  const otherUsers = new Set(allUL.filter((s: any) => s.props?.userId !== userId).map((s: any) => s.props?.userId))
  const userIndex = otherUsers.size
  const x = MARGIN_X - (userIndex * USER_GAP)
  const h = Math.max(20, bounds.maxY - bounds.minY)

  // Best-effort line number lookup (async, used for metadata only)
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
      isLocked: true,
      opacity: 1,
      props: { w: BAR_WIDTH, h, userId, displayName, startLine, endLine, status, userIndex },
    })
  }
}

/** Returns true if a highlight shape is in the ribbon zone (left margin) */
export function isInRibbonZone(editor: Editor, shapeId: TLShapeId): boolean {
  const bounds = editor.getShapePageBounds(shapeId)
  if (!bounds) return false
  // Ribbon zone: entirely in the left margin (x < 0)
  return bounds.maxX < 5
}
