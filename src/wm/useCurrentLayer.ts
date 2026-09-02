/**
 * The React binding for `resolveContextLayer`. Separate from it so the
 * resolution can be tested without a renderer, and so there is exactly one
 * derivation of "which layer am I on" behind both.
 */

import { useEditor } from 'tldraw'
import { useVisibilityViewportId } from '../shapes/useIsInViewport'
import { editorViewportLayerLookup, resolveContextLayer, type ContextLayerResolution } from './layer-context'

export function useCurrentLayer(): ContextLayerResolution {
  const editor = useEditor()
  const viewportId = useVisibilityViewportId()
  return resolveContextLayer(viewportId, editorViewportLayerLookup(editor))
}
