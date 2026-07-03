import type { Editor, TLShapeId } from 'tldraw'

type HtmlSelectionRect = {
  offsetLeft: number
  offsetTop: number
  width: number
  height: number
}

type HtmlSelectionDocSize = {
  width?: number
  height?: number
}

type HtmlTextSelection = {
  shapeId: string
  text: string
  line?: number
  rect?: HtmlSelectionRect
  docSize?: HtmlSelectionDocSize
  createdAt: number
}

type RawHtmlTextSelection = {
  shapeId?: unknown
  text?: unknown
  line?: unknown
  rect?: {
    offsetLeft?: unknown
    offsetTop?: unknown
    width?: unknown
    height?: unknown
  }
  docSize?: {
    width?: unknown
    height?: unknown
  }
}

type HtmlPageShapeLike = {
  id: TLShapeId
  type: string
  parentId?: string
  x: number
  y: number
  props: { w: number }
}

const RECENT_SELECTION_MS = 2 * 60 * 1000
const htmlTextSelections = new Map<string, HtmlTextSelection>()

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function recordHtmlTextSelection(data: unknown) {
  if (!data || typeof data !== 'object') return
  const raw = data as RawHtmlTextSelection
  const shapeId = typeof raw.shapeId === 'string' ? raw.shapeId : ''
  const text = typeof raw.text === 'string' ? raw.text.trim() : ''
  if (!shapeId || !text) return

  const rect = raw.rect && typeof raw.rect === 'object'
    ? {
        offsetLeft: asNumber(raw.rect.offsetLeft) ?? 0,
        offsetTop: asNumber(raw.rect.offsetTop) ?? 0,
        width: asNumber(raw.rect.width) ?? 0,
        height: asNumber(raw.rect.height) ?? 0,
      }
    : undefined
  const line = asNumber(raw.line)

  htmlTextSelections.set(shapeId, {
    shapeId,
    text,
    line,
    rect,
    docSize: raw.docSize && typeof raw.docSize === 'object'
      ? { width: asNumber(raw.docSize.width), height: asNumber(raw.docSize.height) }
      : undefined,
    createdAt: Date.now(),
  })
}

export function clearHtmlTextSelection(shapeId: string) {
  htmlTextSelections.delete(shapeId)
}

function isHtmlPageShapeLike(shape: unknown): shape is HtmlPageShapeLike {
  if (!shape || typeof shape !== 'object') return false
  const candidate = shape as Partial<HtmlPageShapeLike>
  return candidate.type === 'html-page' &&
    typeof candidate.id === 'string' &&
    typeof candidate.x === 'number' &&
    typeof candidate.y === 'number' &&
    !!candidate.props &&
    typeof candidate.props.w === 'number'
}

function expandedIntersects(a: { minX: number; minY: number; maxX: number; maxY: number }, b: { minX: number; minY: number; maxX: number; maxY: number }, pad: number) {
  return a.maxX + pad >= b.minX && a.minX - pad <= b.maxX &&
    a.maxY + pad >= b.minY && a.minY - pad <= b.maxY
}

export function applyHtmlSelectionToHighlight(editor: Editor, highlightId: TLShapeId): boolean {
  const highlight = editor.getShape(highlightId)
  if (!highlight || (highlight.type as string) !== 'highlight') return false
  const highlightBounds = editor.getShapePageBounds(highlightId)
  if (!highlightBounds) return false

  const now = Date.now()
  let best: { selection: HtmlTextSelection; htmlShape: HtmlPageShapeLike; distance: number } | null = null

  for (const selection of htmlTextSelections.values()) {
    if (now - selection.createdAt > RECENT_SELECTION_MS) continue
    const htmlShape = editor.getShape(selection.shapeId as TLShapeId)
    if (!isHtmlPageShapeLike(htmlShape)) continue
    if (htmlShape.parentId && highlight.parentId && htmlShape.parentId !== highlight.parentId) continue

    const pageBounds = editor.getShapePageBounds(htmlShape.id)
    if (!pageBounds || !expandedIntersects(highlightBounds, pageBounds, 16)) continue

    let distance = 0
    if (selection.rect) {
      const docWidth = selection.docSize?.width && selection.docSize.width > 0 ? selection.docSize.width : 800
      const scale = htmlShape.props.w / docWidth
      const selected = {
        minX: htmlShape.x + selection.rect.offsetLeft * scale,
        minY: htmlShape.y + selection.rect.offsetTop * scale,
        maxX: htmlShape.x + (selection.rect.offsetLeft + selection.rect.width) * scale,
        maxY: htmlShape.y + (selection.rect.offsetTop + selection.rect.height) * scale,
      }
      if (!expandedIntersects(highlightBounds, selected, 32)) continue
      const hy = (highlightBounds.minY + highlightBounds.maxY) / 2
      const sy = (selected.minY + selected.maxY) / 2
      distance = Math.abs(hy - sy)
    }

    if (!best || distance < best.distance) best = { selection, htmlShape, distance }
  }

  if (!best) return false

  const { selection, htmlShape } = best
  const lines = selection.text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  editor.updateShape({
    id: highlight.id,
    type: highlight.type,
    meta: {
      ...highlight.meta,
      highlightText: selection.text,
      highlightedText: selection.text,
      highlightLines: lines.length > 0 ? lines : [selection.text],
      sourceLines: selection.line
        ? [{ line: selection.line, content: selection.text, highlighted: true }]
        : undefined,
      sourceAnchor: selection.line ? { line: selection.line } : undefined,
      htmlPageShapeId: htmlShape.id,
    },
  } as unknown as Parameters<Editor['updateShape']>[0])

  return true
}
