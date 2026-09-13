/**
 * Surface layers whose lifetime is a **shape's**, not a renderer's.
 *
 * A docview and a doc-clip each draw into a layer keyed by their own
 * `shape.id`, in the one editor-scoped `WMCore`. Two things follow, and the
 * second is what this module exists for.
 *
 * **The id is derived from the shape, so there is one derivation.** The
 * renderer that ensures the layer and the disposal that removes it must agree
 * on the string or the removal silently misses.
 *
 * **The removal belongs to shape deletion, not component unmount.** The fleet
 * HUD is a second viewport over the same store, so one shape mounts *twice*
 * against the same core with the same layer id. Removing the layer in each
 * renderer's unmount therefore deleted it out from under the other renderer:
 * `Layer "fleet-docview:…" is not defined`. That cleanup was correct while
 * every surface had its own core and became wrong the moment `c6cb4d66a`
 * consolidated them into one — nothing revisited it then.
 *
 * Two renderers of one shape are not two owners. Nothing counts them.
 *
 * This is a separate module from `tlda-shape-layers.ts` only so it can be
 * exercised without the client bundle: that module reaches `fleet-ownership`
 * and from there the whole app, which cannot be loaded outside a browser.
 */
import type { Editor } from 'tldraw'
import type { WMCore } from './wm-core.ts'
import { removeLayers } from './editor-wm.ts'
import { fleetDocviewLayerId } from './fleet-docview-layer.ts'

/** The layer a doc-clip shape draws into, derived from the shape's id alone. */
export function docClipLayerId(shapeId: string) {
	return `doc-clip:${shapeId}`
}

/** Shape types that own a surface layer keyed by their own id. */
export const SURFACE_LAYER_ID_BY_TYPE: Record<string, (shapeId: string) => string> = {
	'fleet-docview': fleetDocviewLayerId,
	'doc-clip': docClipLayerId,
}

/** The layer this shape owns, or null if its type owns none. */
export function surfaceLayerIdOfShape(shape: { id: string; type: string }): string | null {
	const layerIdOf = SURFACE_LAYER_ID_BY_TYPE[shape.type]
	return layerIdOf ? layerIdOf(shape.id) : null
}

const installed = new WeakSet<Editor>()

/**
 * Remove a shape's surface layer when the shape is deleted. Idempotent per
 * editor, because `installTldaShapeLayers` is called at every editor mount.
 */
export function installSurfaceLayerDisposal(editor: Editor, wm: WMCore) {
	if (installed.has(editor)) return
	installed.add(editor)
	editor.sideEffects.registerAfterDeleteHandler('shape', (shape) => {
		const layerId = surfaceLayerIdOfShape(shape)
		if (layerId) removeLayers(wm, [layerId])
	})
}
