import type { Editor, TLShapeId } from 'tldraw'

type ShapeLike = {
  id?: TLShapeId
  type?: string
  meta?: {
    temporaryMarkdownColumn?: unknown
    foreignDocumentPage?: unknown
  }
}

function asShapeLike(value: unknown): ShapeLike {
  return value && typeof value === 'object' ? value as ShapeLike : {}
}

export function isDocumentPageShape(s: unknown): boolean {
  const shape = asShapeLike(s)
  const type = shape.type
  if (type !== 'svg-page' && type !== 'html-page') return false
  if (shape.meta?.temporaryMarkdownColumn) return false
  if (shape.meta?.foreignDocumentPage) return false
  // Auto-opened foreign pages predate the meta flag and still sit in live rooms;
  // do not migrate them in place, because writing to that room is what this fix
  // avoids. Matched narrowly on the -p<N> suffix useDocAutoOpen writes, so a
  // real project named foreign-* keeps its own -page-<N> pages.
  if (/^shape:foreign-.+-p\d+$/.test(String(shape.id || ''))) return false
  return true
}

export function isCanvasPageShape(s: unknown): boolean {
  const type = asShapeLike(s).type
  return type === 'svg-page' ||
    type === 'html-page' ||
    type === 'zoomable-image' ||
    type === 'image'
}

export function sendCanvasPageShapesToBack(editor: Editor) {
  const ids = editor.getCurrentPageShapes()
    .filter(isCanvasPageShape)
    .map(s => s.id as TLShapeId)
  if (ids.length > 0) editor.sendToBack(ids)
}
