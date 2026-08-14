/**
 * Returns true when a shape is in (or near) the viewport.
 *
 * Uses a 400-screen-pixel margin so shapes slightly off-screen stay mounted
 * during scrolling/zooming, preventing rapid mount/unmount thrashing at
 * viewport edges.
 */
import { Fragment, createContext, createElement, useContext, useSyncExternalStore, type ReactNode } from 'react'
import { useEditor, useValue } from 'tldraw'
import type { Editor, TLShapeId, TLViewportId } from 'tldraw'
import { FLEET_HUD_VIEWPORT_ID } from '../wm/fleet-hud-layer'

const MARGIN_PX = 400  // screen pixels of hysteresis on each side

export type VisibilityViewportId = TLViewportId

interface VisibilityViewportContextValue {
  viewportId?: VisibilityViewportId
  keepMounted?: boolean
}

const VisibilityViewportContext = createContext<VisibilityViewportContextValue>({})

export function useVisibilityViewportId(): VisibilityViewportId | undefined {
  return useContext(VisibilityViewportContext).viewportId
}

const FLEET_HUD_OPEN_BODY_CLASS = 'fleet-hud-open'

function isFleetHudOpenBodyState(): boolean {
  return typeof document !== 'undefined' && document.body.classList.contains(FLEET_HUD_OPEN_BODY_CLASS)
}

function subscribeFleetHudOpenBodyState(onStoreChange: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
  const observer = new MutationObserver(onStoreChange)
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}

export function useMainCanvasFleetShapeHiddenByHud(): boolean {
  const viewportId = useVisibilityViewportId()
  const hudOpen = useSyncExternalStore(
    subscribeFleetHudOpenBodyState,
    isFleetHudOpenBodyState,
    () => false,
  )
  if (viewportId) return viewportId !== FLEET_HUD_VIEWPORT_ID
  return hudOpen
}

export function FleetHudRenderGate({ children }: { children: ReactNode }) {
  return useMainCanvasFleetShapeHiddenByHud() ? null : createElement(Fragment, null, children)
}

export function VisibilityViewportProvider({
  viewportId,
  keepMounted = false,
  children,
}: {
  viewportId?: VisibilityViewportId
  keepMounted?: boolean
  children: ReactNode
}) {
  return createElement(VisibilityViewportContext.Provider, { value: { viewportId, keepMounted } }, children)
}

export function getOptionalVisibilityViewport(editor: Editor, viewportId: TLViewportId) {
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
  const { viewportId, keepMounted } = useContext(VisibilityViewportContext)
  return useValue('isInViewport', () => {
    if (keepMounted) return true
    const bounds = editor.getShapePageBounds(shapeId as TLShapeId)
    if (!bounds) return true  // unknown → assume visible
    let vp = editor.getViewportPageBounds()
    if (viewportId) {
      const registered = getOptionalVisibilityViewport(editor, viewportId)
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
  }, [editor, shapeId, viewportId, keepMounted])
}
