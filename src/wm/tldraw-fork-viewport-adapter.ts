import type { Editor, TLViewportId } from 'tldraw'
import type { Camera, ForkViewportAdapter, Point } from './wm-core.ts'

// The missing half of `LayerBacking: { kind: 'viewport' }`. wm-core has routed
// through this interface since it was written; nothing ever implemented it, so
// no viewport-backed layer existed and the path had never run.
//
// It delegates rather than reimplements, deliberately. tldraw's conversion is
//
//   pageToScreen: (x + camera.x) * camera.z + screenBounds.x
//
// and that `screenBounds` term is the whole reason two panes sit in different
// places on screen. Recomputing the arithmetic here would work until tldraw
// changed it, and then fail as a connector landing somewhere plausible and
// wrong — which is the hardest kind of wrong to notice.

export function tldrawForkViewportAdapter(editor: Editor): ForkViewportAdapter {
  return {
    pageToScreen(point: Point, { viewportId }: { viewportId: string }): Point {
      const screen = editor.pageToScreen(point, { viewportId: viewportId as TLViewportId })
      return { x: screen.x, y: screen.y }
    },
    screenToPage(point: Point, { viewportId }: { viewportId: string }): Point {
      const page = editor.screenToPage(point, { viewportId: viewportId as TLViewportId })
      return { x: page.x, y: page.y }
    },
    getCamera(viewportId: string): Camera {
      const { camera } = editor.getViewport(viewportId as TLViewportId)
      return { x: camera.x, y: camera.y, z: camera.z ?? 1 }
    },
    setCamera(viewportId: string, camera: Camera): void {
      editor.updateViewport(viewportId as TLViewportId, { camera })
    },
  }
}
