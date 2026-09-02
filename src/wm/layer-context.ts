/**
 * Which layer am I on — asked once, answered from one place.
 *
 * Skip, 2026-08-13 04:17:59 EDT, naming this as the second of the two things
 * that make layers real: *"And b like, Obviously, the React context and the
 * window manager's registry have to agree"*.
 *
 * There were two answers to that question. React knows which viewport is
 * rendering a component — `VisibilityViewportContext` carries the id. The WM
 * registry knows which coordinate layer a viewport projects into. Agreement is
 * not something to check after the fact and repair; it is what you get when
 * there is one derivation, and this is it: **the React context supplies the
 * viewport, the registry supplies the layer, and nothing else may answer.**
 *
 * The failure this closes is not a mismatch between two stored values. It is a
 * component rendering inside a viewport that was never registered and quietly
 * being treated as though it were on the document — a shape that then compares,
 * snaps and moves against things in a frame it is not in. That case is now
 * distinguishable: it returns `null` rather than the document layer, and a
 * caller has to say what it wants to do about it.
 */

import type { Editor, TLViewportId } from 'tldraw'
import type { LayerId } from './wm-core.ts'
import { getRegisteredViewportLayer } from './editor-wm.ts'
import { FLEET_HUD_DOCUMENT_LAYER_ID } from './fleet-hud-layer.ts'

/** What a viewport id resolves to, kept separate so it is testable without React. */
export type ViewportLayerLookup = (viewportId: TLViewportId) => { coordinateLayerId: LayerId } | undefined

export type ContextLayerResolution =
  /** No viewport context: this is the main canvas, drawing the document. */
  | { kind: 'document'; layerId: LayerId }
  /** In a registered viewport: the layer that viewport projects into. */
  | { kind: 'viewport'; layerId: LayerId; viewportId: TLViewportId }
  /**
   * In a viewport the WM does not know. There is no layer to report and the
   * document layer would be a guess — the whole seam A7 names.
   */
  | { kind: 'unregistered'; layerId: null; viewportId: TLViewportId }

/**
 * Resolve the layer a component is rendering into.
 *
 * Pure, so the three cases can be exercised directly. `useCurrentLayer` is the
 * React binding and adds nothing but the two lookups.
 */
export function resolveContextLayer(
  viewportId: TLViewportId | undefined,
  lookup: ViewportLayerLookup,
): ContextLayerResolution {
  if (!viewportId) return { kind: 'document', layerId: FLEET_HUD_DOCUMENT_LAYER_ID }
  const registered = lookup(viewportId)
  if (!registered) return { kind: 'unregistered', layerId: null, viewportId }
  return { kind: 'viewport', layerId: registered.coordinateLayerId, viewportId }
}

/** The lookup half, bound to an editor's registry. */
export function editorViewportLayerLookup(editor: Editor): ViewportLayerLookup {
  return viewportId => getRegisteredViewportLayer(editor, viewportId)
}
