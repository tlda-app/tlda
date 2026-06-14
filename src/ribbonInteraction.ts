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

type LineYEntry = { file: string; line: number; canvasY: number }

const lineYIndexCache = new Map<string, Array<LineYEntry>>()

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
): Promise<Array<LineYEntry>> {
  if (lineYIndexCache.has(docName)) return lineYIndexCache.get(docName)!

  const lookup = await loadLookup(docName)
  if (!lookup) return []

  const pageInfos = pagesToInfos(pages)
  const result: Array<LineYEntry> = []
  for (const [key, entry] of Object.entries(lookup.lines)) {
    // Multi-file projects key lines as "file.tex:N"; bare "N" is the main file.
    // Keep the file so the same line number in different \input files stays
    // distinct — collapsing them is what ballooned marks across pages on edit.
    const hasFile = key.includes(':')
    const file = hasFile ? key.split(':')[0] : ''
    const lineNum = parseInt(hasFile ? key.split(':')[1] : key, 10)
    if (isNaN(lineNum)) continue
    const canvas = pdfToCanvas(entry.page, entry.x, entry.y, pageInfos)
    if (canvas) result.push({ file, line: lineNum, canvasY: canvas.y })
  }
  result.sort((a, b) => a.canvasY - b.canvasY)
  lineYIndexCache.set(docName, result)
  return result
}

// Nearest index entry to a canvas-Y, returning its file as well as its line so
// the caller can anchor a segment endpoint to the right \input file.
function findClosestLine(
  index: Array<LineYEntry>,
  targetY: number
): { file: string; line: number } | null {
  if (index.length === 0) return null
  let lo = 0, hi = index.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (index[mid].canvasY < targetY) lo = mid + 1
    else hi = mid
  }
  const candidates = [lo > 0 ? index[lo - 1] : null, index[lo]]
    .filter((x): x is LineYEntry => x != null)
  const best = candidates.sort((a, b) =>
    Math.abs(a.canvasY - targetY) - Math.abs(b.canvasY - targetY)
  )[0]
  return best ? { file: best.file, line: best.line } : null
}

function lineToCanvasY(
  index: Array<LineYEntry>,
  file: string,
  lineNum: number
): number | null {
  if (index.length === 0) return null
  let best: LineYEntry | null = null
  let bestDiff = Infinity
  for (const e of index) {
    if (e.file !== file) continue
    const diff = Math.abs(e.line - lineNum)
    if (diff === 0) return e.canvasY
    if (diff < bestDiff) { bestDiff = diff; best = e }
  }
  return best?.canvasY ?? null
}

// Canvas-Y extent (top, bottom) spanned by the source lines in [loLine, hiLine]
// belonging to `files`. Restricting to the segment's own file(s) is what keeps a
// same-numbered line in another \input file from stretching the band across pages.
// Within a single file, synctex Y is not monotonic in line number (display math,
// page breaks), so taking min/max over the range — rather than resolving the two
// endpoints independently — keeps the band from inverting or collapsing.
// Falls back to the endpoints' nearest-line positions when no lines land in range.
function lineRangeToCanvasYExtent(
  index: Array<LineYEntry>,
  files: Set<string>,
  loLine: number,
  hiLine: number
): { top: number; bottom: number } | null {
  if (index.length === 0) return null
  let top = Infinity
  let bottom = -Infinity
  for (const e of index) {
    if (!files.has(e.file)) continue
    if (e.line < loLine || e.line > hiLine) continue
    if (e.canvasY < top) top = e.canvasY
    if (e.canvasY > bottom) bottom = e.canvasY
  }
  if (top === Infinity) {
    // No surviving lines inside the range — fall back to the endpoints.
    const firstFile = files.values().next().value ?? ''
    const a = lineToCanvasY(index, firstFile, loLine)
    const b = lineToCanvasY(index, firstFile, hiLine)
    if (a == null || b == null) return null
    return { top: Math.min(a, b), bottom: Math.max(a, b) }
  }
  return { top, bottom }
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

// Largest vertical gap (canvas px) across which two same-status segments are
// still considered "touching" and get coalesced. Smaller than the eraser band
// (2*ERASE_RADIUS) so an erased gap always survives — erase visibly clears.
const COALESCE_GAP_PX = 1.5

// Collapse the segment list to its minimal form: drop empty/unchecked spans,
// then merge any run of contiguous same-status segments into one. This is what
// bounds the count — without it, every mark and every erase-split adds a
// fragment that never merges back (the 43k-segment bloat). Run on every write.
export function normalizeSegments(segments: RibbonSegment[]): RibbonSegment[] {
  // Sort by position AND status. The status tiebreaker is load-bearing: without
  // it, exact-overlapping duplicates of alternating status (the same line marked
  // uncertain/approved/uncertain/… — the actual shape of the bregman bloat) stay
  // interleaved, so no two consecutive entries share a status and none collapse.
  // Grouping same-status duplicates makes the absorb-step below fold them to one.
  const colored = segments
    .filter(s => s.status !== 'unchecked' && s.y2 - s.y1 > 0)
    .sort((a, b) => a.y1 - b.y1 || a.y2 - b.y2 ||
      (a.status < b.status ? -1 : a.status > b.status ? 1 : 0))

  const out: RibbonSegment[] = []
  for (const seg of colored) {
    const last = out[out.length - 1]
    if (last && last.status === seg.status && seg.y1 <= last.y2 + COALESCE_GAP_PX) {
      // Same status and touching/overlapping/duplicate — absorb into the run.
      // Take the union span and carry the lower endpoint's line/file so remap
      // stays anchored. A contained/duplicate segment (y2 <= last.y2) is dropped.
      if (seg.y2 > last.y2) {
        last.y2 = seg.y2
        last.endLine = seg.endLine
        last.endFile = seg.endFile
      }
    } else {
      out.push({ ...seg })
    }
  }
  return out
}

function setSegments(editor: Editor, segments: RibbonSegment[]) {
  const shape = getRibbonShape(editor)
  if (!shape) return
  const normalized = normalizeSegments(segments)
  editor.store.update(RIBBON_SHAPE_ID, (s: any) => ({
    ...s,
    props: { ...s.props, segments: JSON.stringify(normalized) },
  }))
}

export function mergeSegment(
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
    // Partial overlap — trim. The cut endpoint adopts the new segment's
    // boundary line *and its file*, so the survivor remaps correctly.
    if (seg.y1 < newSeg.y1) {
      result.push({ ...seg, y2: newSeg.y1, endLine: newSeg.startLine, endFile: newSeg.startFile })
    }
    if (seg.y2 > newSeg.y2) {
      result.push({ ...seg, y1: newSeg.y2, startLine: newSeg.endLine, startFile: newSeg.endFile })
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
  const startRef = findClosestLine(index, bounds.minY)
  const endRef = findClosestLine(index, bounds.maxY)

  const y1 = Math.max(0, bounds.minY - ribbonY)
  const y2 = Math.min((ribbon.props as any).h, bounds.maxY - ribbonY)

  const newSeg: RibbonSegment = {
    startLine: startRef?.line ?? 0,
    endLine: endRef?.line ?? 0,
    startFile: startRef?.file ?? '',
    endFile: endRef?.file ?? '',
    status, y1, y2,
  }
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

  console.log(`[Ribbon] ${status}: lines ${newSeg.startLine}–${newSeg.endLine}`)
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

  const MIN_SPAN_PX = 2

  for (const seg of segments) {
    const loLine = Math.min(seg.startLine, seg.endLine)
    const hiLine = Math.max(seg.startLine, seg.endLine)
    // Resolve within the segment's own file(s). Legacy segments predate the
    // file fields — anchor them to the file nearest their last position.
    const files = new Set<string>()
    if (seg.startFile !== undefined || seg.endFile !== undefined) {
      files.add(seg.startFile ?? '')
      files.add(seg.endFile ?? '')
    } else {
      const ref = findClosestLine(index, seg.y1 + ribbonY)
      files.add(ref?.file ?? '')
    }
    const extent = lineRangeToCanvasYExtent(index, files, loLine, hiLine)
    if (!extent) continue

    let y1 = extent.top - ribbonY
    let y2 = extent.bottom - ribbonY

    // Collapse guard: if the remap flattened the band (lines merged onto a
    // single Y), keep the prior span rather than render an invisible sliver.
    if (y2 - y1 < MIN_SPAN_PX && seg.y2 - seg.y1 >= MIN_SPAN_PX) {
      y1 = seg.y1
      y2 = seg.y2
    }

    updated.push({ ...seg, y1, y2 })
  }

  // Write if the remap moved anything OR if coalescing would shrink the set
  // (this is the self-heal path: a bloated doc collapses on its next reload,
  // even when every segment's y is unchanged).
  const normalized = normalizeSegments(updated)
  const positionsChanged = updated.length !== segments.length ||
    updated.some((s, i) => Math.abs(s.y1 - segments[i].y1) > 0.5 || Math.abs(s.y2 - segments[i].y2) > 0.5)
  if (positionsChanged || normalized.length !== segments.length) {
    setSegments(editor, updated)
    console.log(`[Ribbon] Remapped ${segments.length} → ${normalized.length} segment(s) after rebuild`)
  }
}

export function isInRibbonZone(editor: Editor, shapeId: TLShapeId): boolean {
  const bounds = editor.getShapePageBounds(shapeId)
  if (!bounds) return false
  return bounds.minX < 5
}

// Half-height (page-space px) of the band one eraser pass clears around the
// pointer. The lane is narrow, so only the vertical reach matters.
const ERASE_RADIUS = 6

/**
 * Set up eraser-in-ribbon detection. When the eraser is used in the ribbon's
 * x-zone, clear only the band the pointer actually scrubs over — live, as it
 * moves — rather than trimming the mark to the bounding box of the whole
 * gesture (which read as the mark "resizing" to follow the cursor).
 */
export function setupRibbonEraser(
  editor: Editor,
  docName: string,
  pages: SvgPage[]
): void {
  let eraserActive = false
  let index: Array<LineYEntry> = []

  // Keep a resolved index handy so each pointer_move can erase synchronously.
  // Refreshed on every pointer_down so it survives a rebuild (which clears the cache).
  void getLineYIndex(docName, pages).then(idx => { index = idx })

  // Subtract the band [pageY ± ERASE_RADIUS] from the ribbon's segments.
  const eraseBandAt = (pageY: number) => {
    const ribbon = getRibbonShape(editor)
    if (!ribbon) return
    const ribbonY = ribbon.y
    const h = (ribbon.props as any).h
    const y1 = Math.max(0, (pageY - ERASE_RADIUS) - ribbonY)
    const y2 = Math.min(h, (pageY + ERASE_RADIUS) - ribbonY)
    if (y2 <= y1) return

    const startRef = findClosestLine(index, pageY - ERASE_RADIUS)
    const endRef = findClosestLine(index, pageY + ERASE_RADIUS)
    const eraseSeg: RibbonSegment = {
      startLine: startRef?.line ?? 0,
      endLine: endRef?.line ?? 0,
      startFile: startRef?.file ?? '',
      endFile: endRef?.file ?? '',
      status: 'unchecked', y1, y2,
    }
    const segments = getSegments(editor)
    const merged = mergeSegment(segments, eraseSeg)
    // Only write when the erase actually changed something — avoids a flood of
    // no-op Yjs updates while scrubbing empty parts of the lane.
    if (merged.length !== segments.length ||
        merged.some((s, i) => s !== segments[i])) {
      setSegments(editor, merged)
    }
  }

  editor.on('event', (event: any) => {
    const tool = editor.getCurrentToolId()
    if (tool !== 'eraser') { eraserActive = false; return }

    if (event.name === 'pointer_down' && event.type === 'pointer') {
      const pagePoint = editor.inputs.currentPagePoint
      if (pagePoint.x < MARGIN_X + BAR_WIDTH + 20) {
        eraserActive = true
        void getLineYIndex(docName, pages).then(idx => { index = idx })
        eraseBandAt(pagePoint.y)
      }
    }

    if (event.name === 'pointer_move' && event.type === 'pointer' && eraserActive) {
      eraseBandAt(editor.inputs.currentPagePoint.y)
    }

    if (event.name === 'pointer_up' && event.type === 'pointer') {
      eraserActive = false
    }
  })
}

export { RIBBON_SHAPE_ID }
