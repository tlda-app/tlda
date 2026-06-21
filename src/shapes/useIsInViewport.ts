/**
 * Returns true when a shape is in (or near) the viewport.
 *
 * Uses a 400-screen-pixel margin so shapes slightly off-screen stay mounted
 * during scrolling/zooming, preventing rapid mount/unmount thrashing at
 * viewport edges.
 */
import { createContext, createElement, useContext, type ReactNode } from 'react'
import { useEditor, useValue, type TLViewportId } from 'tldraw'

const MARGIN_PX = 400  // screen pixels of hysteresis on each side

const VisibilityViewportContext = createContext<TLViewportId | undefined>(undefined)

export function VisibilityViewportProvider({
  viewportId,
  children,
}: {
  viewportId?: TLViewportId
  children: ReactNode
}) {
  return createElement(VisibilityViewportContext.Provider, { value: viewportId }, children)
}

export function useIsInViewport(shapeId: string): boolean {
  const editor = useEditor()
  const viewportId = useContext(VisibilityViewportContext)
  return useValue('isInViewport', () => {
    const bounds = editor.getShapePageBounds(shapeId as any)
    if (!bounds) return true  // unknown → assume visible
    let vp = editor.getViewportPageBounds()
    let zoom = editor.getZoomLevel()
    if (viewportId) {
      try {
        const viewport = editor.getViewport(viewportId)
        vp = editor.getViewportPageBounds({ viewport })
        zoom = viewport.camera.z
      } catch (err) {
        // The named viewport is registered after its DOM bounds are measured.
        // Until then, keep the old main-viewport answer rather than unmounting.
        if (import.meta.env.DEV) {
          console.debug('[wm-viewport] visibility fallback before viewport registration', {
            viewportId,
            shapeId,
            err,
          })
        }
      }
    }
    const m = MARGIN_PX / zoom  // convert screen px to page coords
    return !(
      bounds.x         > vp.x + vp.w + m ||
      bounds.x + bounds.w < vp.x         - m ||
      bounds.y         > vp.y + vp.h + m ||
      bounds.y + bounds.h < vp.y         - m
    )
  }, [editor, shapeId, viewportId])
}
