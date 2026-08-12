import type { Editor, TLShapeId } from 'tldraw'
import { htmlSourceLineAnchorAtCanvasY, htmlSourceLineCanvasPosition, type HtmlSourceLineAnchor } from './htmlSourceAnchors'
import { getSourceAnchor, canvasToPdf, pdfToCanvas, resolvAnchor, type SourceAnchor } from './synctexAnchor'
import { unanchoredSourceLocation, type SourceLocationReason } from './sourceLocation'
import { HTML_PAGE_FORMATS } from '../shared/document-formats.mjs'

export type AnchorDocument = {
  name: string
  format?: 'svg' | 'png' | 'html' | 'diff' | 'slides' | 'markdown' | 'qmd'
  pages: Parameters<typeof canvasToPdf>[2]
}

export type AnnotationSourceAnchor =
  | (SourceAnchor & { anchored?: true })
  | HtmlSourceLineAnchor
  | ({ anchored: false; reason: SourceLocationReason; file?: string; page?: 0; shapeId?: string })

export type ResolvedAnnotationAnchor =
  | { anchored: true; canvasX?: number; canvasY: number }
  | (Extract<AnnotationSourceAnchor, { anchored: false }>)

type HtmlPageSourceShape = {
  id: TLShapeId
  type: 'html-page'
  props: { source: string; h?: number }
}

function isHtmlPageSourceShape(shape: unknown): shape is HtmlPageSourceShape {
  const candidate = shape as { type?: unknown; props?: { source?: unknown } }
  return candidate.type === 'html-page' && typeof candidate.props?.source === 'string' && !!candidate.props.source
}

function boundsValue(bounds: any, key: 'x' | 'y' | 'w' | 'h') {
  if (!bounds) return 0
  if (key === 'x') return Number(bounds.x ?? bounds.minX ?? 0)
  if (key === 'y') return Number(bounds.y ?? bounds.minY ?? 0)
  if (key === 'w') return Number(bounds.w ?? bounds.width ?? 0)
  return Number(bounds.h ?? bounds.height ?? 0)
}

function htmlPageAtCanvasPoint(editor: Editor, x: number, y: number) {
  const candidates = (editor.getCurrentPageShapes() as unknown[])
    .filter(isHtmlPageSourceShape)

  for (const shape of candidates) {
    const bounds = editor.getShapePageBounds(shape.id)
    const bx = boundsValue(bounds, 'x')
    const by = boundsValue(bounds, 'y')
    const bw = boundsValue(bounds, 'w')
    const bh = boundsValue(bounds, 'h')
    if (!bw || !bh) continue
    if (x >= bx && x <= bx + bw && y >= by && y <= by + bh) {
      return { shape, bounds }
    }
  }
  return null
}

function htmlPageForSource(editor: Editor, anchor: { shapeId?: string; file?: string }) {
  const shapes = (editor.getCurrentPageShapes() as unknown[])
    .filter(isHtmlPageSourceShape)

  let shape = anchor.shapeId ? shapes.find(s => String(s.id) === String(anchor.shapeId)) : undefined
  if (!shape && anchor.file) shape = shapes.find(s => s.props.source === anchor.file)
  if (!shape) return null
  return { shape, bounds: editor.getShapePageBounds(shape.id) }
}

export async function annotationSourceAnchorAtCanvasPoint(
  editor: Editor,
  document: AnchorDocument,
  x: number,
  y: number,
): Promise<AnnotationSourceAnchor | null> {
  // What the annotation is placed ON decides which source it anchors to, not
  // what the project as a whole is. A LaTeX project's Markdown parts are
  // html-page shapes living on their own TLDraw page, so branching on
  // `document.format` sent every note on those pages down the synctex path and
  // measured their coordinates against the PDF page boxes — a different page in
  // a different coordinate space. That yields no anchor, or a main.tex line the
  // note is nowhere near.
  const htmlPage = htmlPageAtCanvasPoint(editor, x, y)
  if (htmlPage) return htmlSourceLineAnchorAtCanvasY(htmlPage.shape, htmlPage.bounds, y)

  if (HTML_PAGE_FORMATS.has(document.format || '')) return null

  const pdfPos = canvasToPdf(x, y, document.pages)
  if (!pdfPos) return null
  const anchor = await getSourceAnchor(document.name, pdfPos.page, pdfPos.x, pdfPos.y)
  return anchor ? { ...anchor, anchored: true } : unanchoredSourceLocation('missing-synctex')
}

export async function resolveAnnotationSourceAnchor(
  editor: Editor,
  document: AnchorDocument,
  anchor: AnnotationSourceAnchor,
): Promise<ResolvedAnnotationAnchor | null> {
  if (anchor.anchored === false) return anchor

  // Resolve by what the anchor IS, for the same reason we choose by what the
  // annotation sits on: an html-line anchor carries the shape it was taken
  // from, and it has to resolve through that shape even when the project's own
  // format is LaTeX.
  if ('shapeId' in anchor && anchor.shapeId) {
    const htmlAnchor = anchor as Extract<HtmlSourceLineAnchor, { anchored: true }>
    const page = htmlPageForSource(editor, htmlAnchor)
    if (!page) return { anchored: false, reason: 'unresolved', file: htmlAnchor.file, page: 0, shapeId: htmlAnchor.shapeId || '' }
    const resolved = htmlSourceLineCanvasPosition(page.shape, page.bounds, htmlAnchor.line)
    if (!resolved) return null
    if (resolved.anchored) return { anchored: true, canvasY: resolved.canvasY }
    return resolved
  }

  const pdfPos = await resolvAnchor(document.name, anchor as SourceAnchor)
  if (!pdfPos) return null
  const canvasPos = pdfToCanvas(pdfPos.page, pdfPos.x, pdfPos.y, document.pages)
  return canvasPos ? { anchored: true, canvasX: canvasPos.x, canvasY: canvasPos.y } : null
}
