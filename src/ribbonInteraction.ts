/**
 * Ribbon interaction — converts highlights drawn in the left-margin ribbon zone
 * into understanding-line shapes instead of text highlights.
 *
 * The ribbon zone is x < 0 in canvas/page space (left of the document pages).
 * When the user highlights in this zone, the highlight is consumed and a
 * corresponding understanding-line shape is created/updated.
 *
 * Eraser in the ribbon zone deletes segments (bare lane = unchecked).
 *
 * Phase 2: Edit resilience — after a document rebuild, understanding-line shapes
 * are repositioned to match the new synctex data (clearLineYIndexCache +
 * remapUnderstandingLines). A full-document unchecked background shape
 * (umap-bg-{userId}) fills the ribbon behind status segments.
 *
 * Content anchoring: at mark time the source text at the marked position is
 * fetched and stored in shape.meta.sourceAnchor.content. On remap, that
 * fingerprint drives a content search (/highlight endpoint) to find the current
 * line, avoiding the line-number drift that happens when lines are inserted or
 * deleted before the mark.
 */

import type { Editor, TLShapeId } from 'tldraw'
import { loadLookup } from './synctexLookup'
import { pdfToCanvas, canvasToPdf } from './synctexAnchor'
import { getHumanId, getHumanName } from './fleet/fleet-data.mjs'
import { HIGHLIGHT_TO_STATUS } from './shapes/UnderstandingLineShape'
import type { SvgPage } from './loaders/types'

const MARGIN_X = 0
const BAR_WIDTH = 6

// Cache: docName → sorted [{line, canvasY}] for reverse lookup.
// Cleared via clearLineYIndexCache() after every document rebuild.
const lineYIndexCache = new Map<string, Array<{ line: number; canvasY: number }>>()

/** Clear the cached line-Y index for a document. Call after every rebuild so the
 *  next ribbon operation reads fresh synctex data. */
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

// Find the canvas Y for a given source line number.
// Index is sorted by canvasY (not lineNum), so binary search by line doesn't apply.
// Linear scan is fine — n is typically ~50 entries per document.
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

/**
 * Re-resolve all understanding-line shapes to their new canvas positions after a
 * document rebuild. Must be called AFTER clearLineYIndexCache so we read fresh
 * synctex data.
 *
 * Three behaviors:
 * 1. Delete detection — if the start fingerprint is not found in the source,
 *    the marked text was deleted; remove the shape.
 * 2. endLine remap — if an end content anchor was stored at mark time, remap
 *    endLine independently via a second content search; otherwise preserve the
 *    original line span.
 * 3. Split — if the remapped span (endLine - startLine) exceeds the original
 *    span, content was inserted inside an approved region; split into
 *    [approved][unchecked][approved].
 */
export async function remapUnderstandingLines(
  editor: Editor,
  docName: string,
  pages: SvgPage[]
): Promise<void> {
  if (pages.length === 0) return

  const index = await getLineYIndex(docName, pages)
  if (index.length === 0) return

  const allShapes = editor.getCurrentPageShapes()
  const umapShapes = allShapes.filter(s =>
    (s.type as string) === 'understanding-line' &&
    (s.id as string).startsWith('shape:umap-') &&
    !(s.id as string).startsWith('shape:umap-bg-')
  )

  if (umapShapes.length === 0) return

  const serverUrl = (typeof window !== 'undefined' && (window as any).__tlda_server)
    || (typeof window !== 'undefined' ? window.location.origin : '')

  const toDelete: TLShapeId[] = []
  const toCreate: any[] = []
  const updates: any[] = []

  for (const shape of umapShapes) {
    const props = shape.props as any
    let startLine = props.startLine as number
    let endLine = props.endLine as number
    if (startLine == null || endLine == null) continue

    const originalSpan = endLine - startLine

    type SourceAnchor = {
      file?: string; line?: number; content?: string
      endContent?: string; endLine?: number; originalSpan?: number
    }
    const sourceAnchor = (shape.meta as any)?.sourceAnchor as SourceAnchor | undefined

    let startFound = false
    let endFound = false

    if (sourceAnchor?.content && serverUrl) {
      // --- Start anchor: find where the marked text currently lives ---
      try {
        const resp = await fetch(`${serverUrl}/api/projects/${docName}/highlight`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: sourceAnchor.content, startLine }),
        })
        if (resp.ok) {
          const data = await resp.json()
          const foundLine: number | undefined = data.startLine ?? data.sourceLines?.[0]?.line
          if (foundLine != null) {
            startFound = true
            startLine = foundLine
          } else {
            // Fingerprint search succeeded but returned no match → text was deleted
            toDelete.push(shape.id as TLShapeId)
            continue
          }
        } else if (resp.status === 404) {
          // Text not found in document → marked text was deleted; remove the ghost
          toDelete.push(shape.id as TLShapeId)
          continue
        }
        // Other errors (network, 500, etc.) → fall through to line-number approach
      } catch {
        // Network error: fall through, keep shape at stored position
      }

      // --- End anchor: independently remap endLine ---
      if (startFound && sourceAnchor.endContent && sourceAnchor.endLine != null) {
        try {
          const endResp = await fetch(`${serverUrl}/api/projects/${docName}/highlight`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: sourceAnchor.endContent, startLine: sourceAnchor.endLine }),
          })
          if (endResp.ok) {
            const endData = await endResp.json()
            const foundEnd: number | undefined = endData.startLine ?? endData.sourceLines?.[0]?.line
            if (foundEnd != null) {
              endFound = true
              endLine = foundEnd
            }
          }
        } catch {
          // Fall through to span-preservation
        }
      }

      // If we found the start but not the end, preserve the original span
      if (startFound && !endFound) {
        const storedSpan = sourceAnchor.originalSpan ?? originalSpan
        endLine = startLine + storedSpan
      }
    }

    // --- Split detection ---
    // If the new span is larger than the original, content was inserted inside
    // an approved region. Split into [approved][unchecked][approved].
    const storedOriginalSpan = sourceAnchor?.originalSpan ?? originalSpan
    if (startFound && endFound && endLine > startLine + storedOriginalSpan &&
        (props.status as string) === 'approved') {
      const uid = ((props.userId as string) || 'unknown').replace(/[^a-zA-Z0-9]/g, '')

      // Middle unchecked segment (everything between start and end anchors)
      const midStart = startLine + 1
      const midEnd = endLine - 1
      if (midStart <= midEnd) {
        const midId = `shape:umap-${uid}-${midStart}-${midEnd}` as TLShapeId
        if (!editor.getShape(midId)) {
          const midY = lineToCanvasY(index, midStart)
          const midEndY = lineToCanvasY(index, midEnd)
          if (midY != null && midEndY != null) {
            toCreate.push({
              id: midId,
              type: 'understanding-line',
              x: shape.x,
              y: midY,
              rotation: 0,
              isLocked: true,
              opacity: 1,
              props: { ...props, h: Math.max(20, midEndY - midY), startLine: midStart, endLine: midEnd, status: 'unchecked' },
            })
          }
        }
      }

      // End approved segment (the original end-anchor line)
      const endApprovedId = `shape:umap-${uid}-${endLine}-${endLine}` as TLShapeId
      if (!editor.getShape(endApprovedId)) {
        const endY = lineToCanvasY(index, endLine)
        if (endY != null) {
          toCreate.push({
            id: endApprovedId,
            type: 'understanding-line',
            x: shape.x,
            y: endY,
            rotation: 0,
            isLocked: true,
            opacity: 1,
            props: { ...props, h: 20, startLine: endLine, endLine: endLine, status: 'approved' },
          })
        }
      }

      // Existing shape becomes just the start line (approved)
      endLine = startLine
    }

    const newY = lineToCanvasY(index, startLine)
    const newEndY = lineToCanvasY(index, endLine)
    if (newY == null || newEndY == null) continue

    const newH = Math.max(20, newEndY - newY)
    const yChanged = Math.abs(shape.y - newY) > 0.5
    const hChanged = Math.abs(props.h - newH) > 0.5
    const lineChanged = props.startLine !== startLine || props.endLine !== endLine
    if (yChanged || hChanged || lineChanged) {
      updates.push({
        id: shape.id,
        type: shape.type,
        y: newY,
        props: { ...props, h: newH, startLine, endLine },
        meta: sourceAnchor?.content
          ? { ...shape.meta, sourceAnchor: { ...sourceAnchor, line: startLine } }
          : shape.meta,
      })
    }
  }

  if (toDelete.length > 0) {
    console.log(`[Ribbon] Deleting ${toDelete.length} ghost shape(s) — marked text no longer in source`)
    editor.deleteShapes(toDelete)
  }
  if (toCreate.length > 0) {
    console.log(`[Ribbon] Creating ${toCreate.length} split shape(s) — inserted content inside approved region`)
    for (const s of toCreate) editor.createShape(s)
  }
  if (updates.length > 0) {
    console.log(`[Ribbon] Remapping ${updates.length} understanding-line shape(s) after rebuild`)
    editor.updateShapes(updates)
  }
}

/**
 * Create or update the full-document unchecked background ribbon shape for the
 * current user. This provides a continuous visual track across the entire
 * document height — status segments appear on top of it.
 *
 * The bg shape uses unchecked status (rendered at 30% opacity), so colored status
 * segments above it show through clearly even if z-ordering places bg on top.
 */
export async function initRibbonBackground(
  editor: Editor,
  docName: string,
  pages: SvgPage[]
): Promise<void> {
  if (pages.length === 0) return
  // Ribbons are LaTeX-only — skip for diff/png formats
  if (!docName) return

  const userId = getHumanId()
  if (!userId) return
  const displayName = getHumanName() || userId
  const uid = userId.replace(/[^a-zA-Z0-9]/g, '')

  // Document spans from first page top to last page bottom
  const firstPage = pages[0]
  const lastPage = pages[pages.length - 1]
  const docTop = firstPage.bounds.y
  const docBottom = lastPage.bounds.y + lastPage.bounds.h
  const docHeight = docBottom - docTop

  if (docHeight <= 0) return

  const bgId = `shape:umap-bg-${uid}` as TLShapeId

  const existing = editor.getShape(bgId)
  if (existing) {
    const props = existing.props as any
    const xOk = Math.abs(existing.x - MARGIN_X) <= 0.5
    const yOk = Math.abs(existing.y - docTop) <= 0.5
    const hOk = Math.abs(props.h - docHeight) <= 0.5
    const wOk = props.w === BAR_WIDTH
    const lockOk = existing.isLocked === true
    if (!xOk || !yOk || !hOk || !wOk || !lockOk) {
      editor.updateShape({
        id: bgId,
        type: 'understanding-line' as any,
        x: MARGIN_X,
        y: docTop,
        isLocked: true,
        props: { ...props, w: BAR_WIDTH, h: docHeight },
      })
    }
  } else {
    editor.createShape({
      id: bgId,
      type: 'understanding-line' as any,
      x: MARGIN_X,
      y: docTop,
      rotation: 0,
      isLocked: true,
      opacity: 1,
      props: {
        w: BAR_WIDTH,
        h: docHeight,
        userId,
        displayName,
        startLine: 0,
        endLine: 999999,
        status: 'unchecked',
        userIndex: 0,
      },
    })
  }

  // Self-heal stale segment shapes (unlock + fix width)
  const allShapes = editor.getCurrentPageShapes()
  for (const s of allShapes) {
    if ((s.type as string) !== 'understanding-line') continue
    const ul = s as any
    if (ul.id === bgId) continue
    const p = ul.props as any
    if (p.userId !== userId) continue
    if (!ul.isLocked || p.w !== BAR_WIDTH) {
      editor.updateShape({
        id: ul.id,
        type: 'understanding-line' as any,
        isLocked: true,
        props: { ...p, w: BAR_WIDTH },
      })
    }
  }
}

/**
 * Process a highlight drawn in the ribbon zone (bounds.minX < 5 canvas units).
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

  // Check status before deleting — unknown color keeps the highlight as-is
  if (!status) return

  editor.deleteShape(shapeId)

  const userId = getHumanId()
  if (!userId) return
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
    editor.updateShape({
      id: newShapeId,
      type: 'understanding-line' as any,
      props: { ...(existing.props as any), status },
    })
  } else {
    editor.createShape({
      id: newShapeId,
      type: 'understanding-line' as any,
      x,
      y: bounds.minY,
      rotation: 0,
      isLocked: true,
      opacity: 1,
      props: { w: BAR_WIDTH, h, userId, displayName, startLine, endLine, status, userIndex: 0 },
    })

    // Fetch content fingerprints for start and end lines and store as sourceAnchor.
    // Fire-and-forget — meta update arrives after shape creation.
    void (async () => {
      try {
        const serverUrl = (window as any).__tlda_server || window.location.origin
        const pageInfos = pagesToInfos(pages)

        // Use canonical line positions (not bounds edges, which can fall in whitespace).
        // Keep x=0 (pdfX=-72) so the query falls outside all text records — the fallback
        // then finds the closest line by y distance without being captured by a large
        // section-heading bounding box that would dominate at any in-page x coordinate.
        const startCanvasY = lineToCanvasY(index, startLine) ?? bounds.minY
        const endCanvasY = lineToCanvasY(index, endLine) ?? bounds.maxY
        const startPdfPos = canvasToPdf(0, startCanvasY, pageInfos)
        const endPdfPos = startLine !== endLine ? canvasToPdf(0, endCanvasY, pageInfos) : null
        if (!startPdfPos) return

        const [startResp, endResp] = await Promise.all([
          fetch(`${serverUrl}/api/projects/${docName}/synctex-path`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ page: startPdfPos.page, points: [{ x: startPdfPos.x, y: startPdfPos.y }] }),
          }),
          endPdfPos ? fetch(`${serverUrl}/api/projects/${docName}/synctex-path`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ page: endPdfPos.page, points: [{ x: endPdfPos.x, y: endPdfPos.y }] }),
          }) : Promise.resolve(null),
        ])

        if (!startResp.ok) return
        const startData = await startResp.json()
        // Look for the target startLine specifically, then fall back to first non-blank.
        // The lines array is a context window — without this, a section heading earlier
        // in the window would be picked as the content fingerprint.
        const firstLine = startData.lines?.find((l: any) => l.line >= startLine && l.content?.trim())
                       ?? startData.lines?.find((l: any) => l.content?.trim())
        if (!firstLine?.content) return

        const anchor: Record<string, unknown> = {
          file: startData.file || 'main.tex',
          line: startLine,
          content: firstLine.content,
          originalSpan: endLine - startLine,
        }

        if (endResp?.ok) {
          const endData = await endResp.json()
          const lastLine = endData.lines?.find((l: any) => l.line >= endLine && l.content?.trim())
                       ?? endData.lines?.find((l: any) => l.content?.trim())
          if (lastLine?.content && lastLine.content !== firstLine.content) {
            anchor.endContent = lastLine.content
            anchor.endLine = endLine
          }
        }

        editor.updateShape({
          id: newShapeId,
          type: 'understanding-line' as any,
          meta: { sourceAnchor: anchor },
        } as any)
        console.log(`[Ribbon] Stored anchors for lines ${startLine}–${endLine}: "${firstLine.content.substring(0, 60)}"`)
      } catch {
        // No fingerprint — remap will fall back to line-number approach
      }
    })()
  }
}

/** Returns true if a highlight shape is in the ribbon zone (left margin).
 * Uses minX rather than maxX: highlights have ~20-unit width from stroke thickness,
 * so a stroke drawn at x=0 has maxX≈12 but minX≈-8. */
export function isInRibbonZone(editor: Editor, shapeId: TLShapeId): boolean {
  const bounds = editor.getShapePageBounds(shapeId)
  if (!bounds) return false
  return bounds.minX < 5
}

