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

/**
 * The viewport, or null if nothing has registered it.
 *
 * The same shape as `getOptionalCanvasClipViewport` in `canvas-clip-panel.ts`
 * and `getOptionalVisibilityViewport` in `src/shapes/useIsInViewport.ts`. It is
 * not shared with them because this package must not import from the app, and
 * importing the panel module here would be a cycle.
 */
function getOptionalViewport(editor: Editor, viewportId: TLViewportId) {
  try {
    return editor.getViewport(viewportId)
  } catch (error) {
    if (error instanceof Error && error.message.includes('No viewport registered')) {
      return null
    }
    throw error
  }
}

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
    // Null when the viewport is not registered, rather than throwing.
    //
    // A viewport-backed layer can exist before its viewport does: the layer is
    // defined by whoever lays the surface out, and the viewport is registered
    // by the panel that renders it. `WMCore.camera` is written for that --
    // `getCamera?.(id) ?? cloneCamera(layer.camera)` falls back to the layer's
    // own camera -- but the fallback could never run, because this threw
    // instead of returning nullish. The layer transform then threw, and on the
    // marking surface that took the whole canvas down through tldraw's error
    // boundary.
    //
    // Returning null is also what the two sibling accessors already do for the
    // same condition: `getOptionalCanvasClipViewport` and
    // `getOptionalVisibilityViewport` both swallow this exact message and
    // answer null. "Not registered yet" is an ordinary state on this surface,
    // and this was the one reader treating it as fatal.
    getCamera(viewportId: string): Camera | null {
      const viewport = getOptionalViewport(editor, viewportId as TLViewportId)
      if (!viewport) return null
      const { camera } = viewport
      return { x: camera.x, y: camera.y, z: camera.z ?? 1 }
    },
    setCamera(viewportId: string, camera: Camera): void {
      editor.updateViewport(viewportId as TLViewportId, { camera })
    },
  }
}
