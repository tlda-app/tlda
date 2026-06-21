/**
 * Returns true when a shape is in (or near) the viewport.
 *
 * Uses a 400-screen-pixel margin so shapes slightly off-screen stay mounted
 * during scrolling/zooming, preventing rapid mount/unmount thrashing at
 * viewport edges.
 */
import { createContext, createElement, type ReactNode } from 'react'
import { useEditor, useValue } from 'tldraw'

const MARGIN_PX = 400  // screen pixels of hysteresis on each side

export type VisibilityViewportId = string

const VisibilityViewportContext = createContext<VisibilityViewportId | undefined>(undefined)

export function VisibilityViewportProvider({
  viewportId,
  children,
}: {
  viewportId?: VisibilityViewportId
  children: ReactNode
}) {
  return createElement(VisibilityViewportContext.Provider, { value: viewportId }, children)
}

export function useIsInViewport(shapeId: string): boolean {
  const editor = useEditor()
  return useValue('isInViewport', () => {
    const bounds = editor.getShapePageBounds(shapeId as any)
    if (!bounds) return true  // unknown → assume visible
    const vp = editor.getViewportPageBounds()
    const zoom = editor.getZoomLevel()
    const m = MARGIN_PX / zoom  // convert screen px to page coords
    return !(
      bounds.x         > vp.x + vp.w + m ||
      bounds.x + bounds.w < vp.x         - m ||
      bounds.y         > vp.y + vp.h + m ||
      bounds.y + bounds.h < vp.y         - m
    )
  }, [editor, shapeId])
}
