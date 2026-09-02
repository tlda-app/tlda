/**
 * The React binding for `resolveContextLayer`. Separate from it so the
 * resolution can be tested without a renderer, and so there is exactly one
 * derivation of "which layer am I on" behind both.
 *
 * The lookup runs on every render rather than being cached: the WM registry is
 * not reactive — `CanvasClipPanel` registers its viewport in an effect — so a
 * component can render once before its viewport exists. Re-resolving each time
 * means the next render is right, where a cached first answer would be `null`
 * forever. Only the returned object's *identity* is stabilised, so gesture
 * handlers that depend on it are not rebuilt every render.
 */

import { useEditor } from 'tldraw'
import { useVisibilityViewportId } from '../shapes/useIsInViewport'
import { editorViewportLayerLookup, resolveContextLayer, type ContextLayerResolution } from './layer-context'

export function useCurrentLayer(): ContextLayerResolution {
  const editor = useEditor()
  const viewportId = useVisibilityViewportId()
  // No memo: `resolveContextLayer` interns its results, so the same answer is
  // the same object and a consumer can depend on it directly.
  return resolveContextLayer(viewportId, editorViewportLayerLookup(editor))
}
