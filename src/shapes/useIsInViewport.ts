/**
 * Returns true when a shape is in (or near) the viewport.
 *
 * Uses a 400-screen-pixel margin so shapes slightly off-screen stay mounted
 * during scrolling/zooming, preventing rapid mount/unmount thrashing at
 * viewport edges.
 */
import { createContext, createElement, useContext, type ReactNode } from 'react'
import { useEditor, useValue } from 'tldraw'
import type { Editor, TLShapeId, TLViewportId } from 'tldraw'

const MARGIN_PX = 400  // screen pixels of hysteresis on each side

export type VisibilityViewportId = TLViewportId

const VisibilityViewportContext = createContext<VisibilityViewportId | undefined>(undefined)

export function useVisibilityViewportId(): VisibilityViewportId | undefined {
  return useContext(VisibilityViewportContext)
}

export function VisibilityViewportProvider({
  viewportId,
  children,
}: {
  viewportId?: VisibilityViewportId
  children: ReactNode
}) {
  return createElement(VisibilityViewportContext.Provider, { value: viewportId }, children)
}

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

export function useIsInViewport(shapeId: string): boolean {
  const editor = useEditor()
  const viewportId = useContext(VisibilityViewportContext)
  return useValue('isInViewport', () => {
    const bounds = editor.getShapePageBounds(shapeId as TLShapeId)
    if (!bounds) return true  // unknown → assume visible
    let vp = editor.getViewportPageBounds()
    if (viewportId) {
      const registered = getOptionalViewport(editor, viewportId)
      // Viewport not yet registered → we can't compute correct bounds, so
      // assume visible. Using the main viewport as fallback here causes a
      // false "not in viewport" for fleet shapes (which live far off the main
      // canvas), triggering a MOUNT→UNMOUNT→MOUNT flicker on every HUD init.
      if (!registered) return true
      const z = registered.camera.z || 1
      const x = registered.screenBounds.x / z - registered.camera.x
      const y = registered.screenBounds.y / z - registered.camera.y
      vp = {
        ...vp,
        x,
        y,
        w: registered.screenBounds.w / z,
        h: registered.screenBounds.h / z,
      } as typeof vp
    }
    const zoom = editor.getZoomLevel()
    const m = MARGIN_PX / zoom  // convert screen px to page coords
    return !(
      bounds.x         > vp.x + vp.w + m ||
      bounds.x + bounds.w < vp.x         - m ||
      bounds.y         > vp.y + vp.h + m ||
      bounds.y + bounds.h < vp.y         - m
    )
  }, [editor, shapeId, viewportId])
}
