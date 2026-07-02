import type { Editor, TLShapeId } from 'tldraw'

type ShapeLike = {
  id?: TLShapeId
  type?: string
  meta?: { temporaryMarkdownColumn?: unknown }
}

function asShapeLike(value: unknown): ShapeLike {
  return value && typeof value === 'object' ? value as ShapeLike : {}
}

export function isDocumentPageShape(s: unknown): boolean {
  const shape = asShapeLike(s)
  const type = shape.type
  if (type !== 'svg-page' && type !== 'html-page') return false
  return !shape.meta?.temporaryMarkdownColumn
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
