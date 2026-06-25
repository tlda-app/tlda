import type { Editor, TLViewportId } from 'tldraw'
import { createWMCore, type Point } from './wm-core'

const ROOT_LAYER_ID = 'screen'
const VIEWPORT_LAYER_ID = 'viewport'

function viewportAdapter(editor: Editor) {
  return {
    screenToPage: (point: Point, opts: { viewportId: string }) =>
      editor.screenToPage(point, opts),
    pageToScreen: (point: Point, opts: { viewportId: string }) =>
      editor.pageToScreen(point, opts),
    getCamera: (viewportId: string) => editor.getViewport(viewportId as TLViewportId).camera,
    setCamera: (viewportId: string, camera: { x: number; y: number; z: number }) => {
      editor.updateViewport(viewportId as TLViewportId, { camera })
    },
  }
}

function createViewportCoordinateWM(editor: Editor, viewportId: TLViewportId) {
  const wm = createWMCore({ rootLayerId: ROOT_LAYER_ID })
  wm.defineLayer(VIEWPORT_LAYER_ID, {
    parent: ROOT_LAYER_ID,
    backing: { kind: 'viewport', viewportId, editor: viewportAdapter(editor) },
  })
  return wm
}

export function clientPointToPage(
  editor: Editor,
  point: { x: number; y: number },
  viewportId?: TLViewportId,
) {
  if (!viewportId) return editor.screenToPage(point)
  return createViewportCoordinateWM(editor, viewportId).translate(point, ROOT_LAYER_ID, VIEWPORT_LAYER_ID)
}

export function pagePointToClient(
  editor: Editor,
  point: { x: number; y: number },
  viewportId?: TLViewportId,
) {
  if (!viewportId) return editor.pageToScreen(point)
  return createViewportCoordinateWM(editor, viewportId).translate(point, VIEWPORT_LAYER_ID, ROOT_LAYER_ID)
}

export function pagePointToPage(
  editor: Editor,
  point: { x: number; y: number },
  fromViewportId?: TLViewportId,
  toViewportId?: TLViewportId,
) {
  const clientPoint = pagePointToClient(editor, point, fromViewportId)
  return clientPointToPage(editor, clientPoint, toViewportId)
}
