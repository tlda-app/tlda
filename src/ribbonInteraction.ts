import type { Editor, TLShapeId } from 'tldraw'
import { loadLookup } from './synctexLookup'
import { pdfToCanvas } from './synctexAnchor'
import { HIGHLIGHT_TO_STATUS } from './shapes/UnderstandingLineShape'
import type { RibbonSegment } from './shapes/UnderstandingLineShape'
import type { LineStatus } from './shapes/UnderstandingLineShape'
import type { SvgPage } from './loaders/types'

const MARGIN_X = 0
const BAR_WIDTH = 6
const RIBBON_SHAPE_ID = 'shape:understanding-ribbon' as TLShapeId

const lineYIndexCache = new Map<string, Array<{ line: number; canvasY: number }>>()

export function clearLineYIndexCache(docName: string): void {
  lineYIndexCache.delete(docName)
}

function pagesToInfos(pages: SvgPage[]) {
  return pages.map(p => ({
    bounds: { x: p.bounds.x, y: p.bounds.y, width: p.bounds.w, height: p.bounds.h },
    width: p.width,
    height: p.height,
  }))
}

async function getLineYIndex(
  docName: string,
  pages: SvgPage[]
): Promise<Array<{ line: number; canvasY: number }>> {
  if (lineYIndexCache.has(docName)) return lineYIndexCache.get(docName)!

  const lookup = await loadLookup(docName)
  if (!lookup) return []

  const pageInfos = pagesToInfos(pages)
  const result: Array<{ line: number; canvasY: number }> = []
  for (const [key, entry] of Object.entries(lookup.lines)) {
    const lineNum = parseInt(key.includes(':') ? key.split(':')[1] : key, 10)
    if (isNaN(lineNum)) continue
    const canvas = pdfToCanvas(entry.page, entry.x, entry.y, pageInfos)
    if (canvas) result.push({ line: lineNum, canvasY: canvas.y })
  }
  result.sort((a, b) => a.canvasY - b.canvasY)
  lineYIndexCache.set(docName, result)
  return result
}

function findClosestLine(
  index: Array<{ line: number; canvasY: number }>,
  targetY: number
): number | null {
  if (index.length === 0) return null
  let lo = 0, hi = index.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (index[mid].canvasY < targetY) lo = mid + 1
    else hi = mid
  }
  const candidates = [lo > 0 ? index[lo - 1] : null, index[lo]]
    .filter((x): x is { line: number; canvasY: number } => x != null)
  return candidates.sort((a, b) =>
    Math.abs(a.canvasY - targetY) - Math.abs(b.canvasY - targetY)
  )[0]?.line ?? null
}

function lineToCanvasY(
  index: Array<{ line: number; canvasY: number }>,
  lineNum: number
): number | null {
  if (index.length === 0) return null
  let best: { line: number; canvasY: number } | null = null
  let bestDiff = Infinity
  for (const e of index) {
    const diff = Math.abs(e.line - lineNum)
    if (diff === 0) return e.canvasY
    if (diff < bestDiff) { bestDiff = diff; best = e }
  }
  return best?.canvasY ?? null
}

function getRibbonShape(editor: Editor) {
  return editor.getShape(RIBBON_SHAPE_ID)
}

function getSegments(editor: Editor): RibbonSegment[] {
  const shape = getRibbonShape(editor)
  if (!shape) return []
  try { return JSON.parse((shape.props as any).segments || '[]') }
  catch { return [] }
}

function setSegments(editor: Editor, segments: RibbonSegment[]) {
  const shape = getRibbonShape(editor)
  if (!shape) return
  editor.store.update(RIBBON_SHAPE_ID, (s: any) => ({
    ...s,
    props: { ...s.props, segments: JSON.stringify(segments) },
  }))
}

function mergeSegment(
  existing: RibbonSegment[],
  newSeg: RibbonSegment
): RibbonSegment[] {
  // Remove overlapping portions of existing segments, then insert the new one.
  // "Erase" (unchecked status) clears segments in the range rather than adding.
  const result: RibbonSegment[] = []

  for (const seg of existing) {
    if (seg.y2 <= newSeg.y1 || seg.y1 >= newSeg.y2) {
      // No overlap — keep as-is
      result.push(seg)
      continue
    }
    // Partial overlap — trim
    if (seg.y1 < newSeg.y1) {
      result.push({ ...seg, y2: newSeg.y1, endLine: newSeg.startLine })
    }
    if (seg.y2 > newSeg.y2) {
      result.push({ ...seg, y1: newSeg.y2, startLine: newSeg.endLine })
    }
  }

  if (newSeg.status !== 'unchecked') {
    result.push(newSeg)
  }

  result.sort((a, b) => a.y1 - b.y1)
  return result
}

/**
 * Create or update the single ribbon shape spanning the full document height.
 */
export async function initRibbon(
  editor: Editor,
  _docName: string,
  pages: SvgPage[]
): Promise<void> {
  if (pages.length === 0) return

  const firstPage = pages[0]
  const lastPage = pages[pages.length - 1]
  const docTop = firstPage.bounds.y
  const docBottom = lastPage.bounds.y + lastPage.bounds.h
  const docHeight = docBottom - docTop

  if (docHeight <= 0) return

  const existing = getRibbonShape(editor)
  if (existing) {
    const props = existing.props as any
    const yOk = Math.abs(existing.y - docTop) <= 0.5
    const hOk = Math.abs(props.h - docHeight) <= 0.5
    if (!yOk || !hOk) {
      editor.store.update(RIBBON_SHAPE_ID, (s: any) => ({
        ...s,
        x: MARGIN_X,
        y: docTop,
        isLocked: true,
        props: { ...s.props, w: BAR_WIDTH, h: docHeight },
      }))
    }
  } else {
    editor.createShape({
      id: RIBBON_SHAPE_ID,
      type: 'understanding-line' as any,
      x: MARGIN_X,
      y: docTop,
      rotation: 0,
      isLocked: true,
      opacity: 1,
      props: {
        w: BAR_WIDTH,
        h: docHeight,
        segments: '[]',
      },
    })
  }
}

/**
 * Process a highlight drawn in the ribbon zone. Adds a segment to the
 * single ribbon shape and deletes the highlight.
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
  const status = HIGHLIGHT_TO_STATUS[hlColor] as LineStatus | undefined
  if (!status) return

  // Capture SVG path from DOM before deleting the highlight
  const hlEl = document.querySelector(`[data-shape-id="${shapeId}"]`)
  const svgPath = hlEl?.querySelector('path')
  const pathD = svgPath?.getAttribute('d') || null
  const hlStroke = svgPath?.getAttribute('stroke') || null
  const hlStrokeWidth = svgPath?.getAttribute('stroke-width') || null

  editor.deleteShape(shapeId)

  const ribbon = getRibbonShape(editor)
  if (!ribbon) return

  const ribbonY = ribbon.y

  const index = await getLineYIndex(docName, pages)
  const startLine = findClosestLine(index, bounds.minY) ?? 0
  const endLine = findClosestLine(index, bounds.maxY) ?? 0

  const y1 = Math.max(0, bounds.minY - ribbonY)
  const y2 = Math.min((ribbon.props as any).h, bounds.maxY - ribbonY)

  const newSeg: RibbonSegment = { startLine, endLine, status, y1, y2 }
  const segments = getSegments(editor)
  const merged = mergeSegment(segments, newSeg)
  setSegments(editor, merged)

  if (pathD) {
    window.dispatchEvent(new CustomEvent('ribbon-suck-in', {
      detail: {
        pathD,
        stroke: hlStroke,
        strokeWidth: hlStrokeWidth,
        shapeX: shape.x,
        shapeY: shape.y,
        ribbonY: ribbonY,
        status,
      },
    }))
  }

  console.log(`[Ribbon] ${status}: lines ${startLine}–${endLine}`)
}

/**
 * After a document rebuild, recompute y positions for all segments
 * from their source line numbers.
 */
export async function remapRibbonSegments(
  editor: Editor,
  docName: string,
  pages: SvgPage[]
): Promise<void> {
  if (pages.length === 0) return

  const ribbon = getRibbonShape(editor)
  if (!ribbon) return

  const index = await getLineYIndex(docName, pages)
  if (index.length === 0) return

  const ribbonY = ribbon.y
  const segments = getSegments(editor)
  const updated: RibbonSegment[] = []

  for (const seg of segments) {
    const newY1 = lineToCanvasY(index, seg.startLine)
    const newY2 = lineToCanvasY(index, seg.endLine)
    if (newY1 == null || newY2 == null) continue
    updated.push({
      ...seg,
      y1: newY1 - ribbonY,
      y2: newY2 - ribbonY,
    })
  }

  if (updated.length !== segments.length ||
      updated.some((s, i) => Math.abs(s.y1 - segments[i].y1) > 0.5 || Math.abs(s.y2 - segments[i].y2) > 0.5)) {
    setSegments(editor, updated)
    console.log(`[Ribbon] Remapped ${updated.length} segment(s) after rebuild`)
  }
}

export function isInRibbonZone(editor: Editor, shapeId: TLShapeId): boolean {
  const bounds = editor.getShapePageBounds(shapeId)
  if (!bounds) return false
  return bounds.minX < 5
}

/**
 * Set up eraser-in-ribbon detection. When the eraser tool is used and
 * the stroke overlaps the ribbon's x-extent, clear segments in that
 * y-range instead of (or in addition to) normal eraser behavior.
 */
export function setupRibbonEraser(
  editor: Editor,
  docName: string,
  pages: SvgPage[]
): void {
  let eraserMinY = Infinity
  let eraserMaxY = -Infinity
  let eraserActive = false

  editor.on('event', (event: any) => {
    const tool = editor.getCurrentToolId()
    if (tool !== 'eraser') {
      if (eraserActive) { eraserActive = false; eraserMinY = Infinity; eraserMaxY = -Infinity }
      return
    }

    if (event.name === 'pointer_down' && event.type === 'pointer') {
      const pagePoint = editor.inputs.currentPagePoint
      if (pagePoint.x < MARGIN_X + BAR_WIDTH + 20) {
        eraserActive = true
        eraserMinY = pagePoint.y
        eraserMaxY = pagePoint.y
      }
    }

    if (event.name === 'pointer_move' && event.type === 'pointer' && eraserActive) {
      const pagePoint = editor.inputs.currentPagePoint
      eraserMinY = Math.min(eraserMinY, pagePoint.y)
      eraserMaxY = Math.max(eraserMaxY, pagePoint.y)
    }

    if (event.name === 'pointer_up' && event.type === 'pointer' && eraserActive) {
      eraserActive = false
      const ribbon = getRibbonShape(editor)
      if (!ribbon) return

      const ribbonY = ribbon.y
      const y1 = Math.max(0, eraserMinY - ribbonY)
      const y2 = Math.min((ribbon.props as any).h, eraserMaxY - ribbonY)

      void (async () => {
        const index = await getLineYIndex(docName, pages)
        const startLine = findClosestLine(index, eraserMinY) ?? 0
        const endLine = findClosestLine(index, eraserMaxY) ?? 0

        const eraseSeg: RibbonSegment = { startLine, endLine, status: 'unchecked', y1, y2 }
        const segments = getSegments(editor)
        const merged = mergeSegment(segments, eraseSeg)
        setSegments(editor, merged)
        console.log(`[Ribbon] Erased: lines ${startLine}–${endLine}`)
      })()

      eraserMinY = Infinity
      eraserMaxY = -Infinity
    }
  })
}

export { RIBBON_SHAPE_ID }
