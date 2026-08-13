import type { Editor, TLShape } from 'tldraw'
import type { LayerId, WMCore } from './wm-core.ts'
import {
	getEditorWMCore,
	getRegisteredViewportLayer,
	setShapeLayerReport,
	viewportCoordinateLayerId,
} from './editor-wm.ts'
import {
	FLEET_HUD_DOCUMENT_LAYER_ID,
	FLEET_HUD_OVERLAY_LAYER_ID,
	FLEET_HUD_ROOT_LAYER_ID,
	FLEET_HUD_VIEWPORT_ID,
	ensureFleetHudLayers,
} from './fleet-hud-layer.ts'
import { ensureLayer } from './editor-wm.ts'
import { isMyFleetShape } from '../shapes/fleet-ownership.ts'

/**
 * tlda's answer to "which layer is this shape in".
 *
 * One rule: **a shape is in the coordinate layer of the viewport that projects
 * it.** Everything the app draws goes through the main viewport and is therefore
 * in `document-page`, except the panels this browser owns while the fleet HUD is
 * projecting them, which are in the HUD viewport's own coordinate layer.
 *
 * Both of those layers take page coordinates — numerically a panel's `x` is the
 * same number in either. What differs is the camera that puts them on screen,
 * and that is what a layer is. Two shapes in different layers can sit at
 * identical page coordinates and be nowhere near each other on the display, so
 * any operation that reasons in screen space has to ask which layer it is in
 * before it compares them.
 *
 * A shape's layer is not stored. It is read off the shape record and the set of
 * registered viewports, both of which are already true; a stored copy would be a
 * second answer that could disagree with them.
 */
export function tldaShapeLayerId(editor: Editor, shape: unknown): LayerId | null {
	if (!shape || typeof shape !== 'object') return null

	// A managed surface names its own layer on its record — `managedLayerId`,
	// written by managedSurfaceShapeMeta. The surface declared where it lives
	// when it was requested, so there is nothing to infer.
	const managed = (shape as { meta?: { managedLayerId?: unknown } }).meta?.managedLayerId
	if (typeof managed === 'string' && managed) return managed

	if (isMyFleetShape(shape)) {
		// While the HUD projects them. With the HUD closed there is no HUD
		// viewport, the main canvas is the only thing drawing these panels, and
		// they are in `document-page` like everything else — which is the truth,
		// not a fallback: membership follows the projection.
		const hud = getRegisteredViewportLayer(editor, FLEET_HUD_VIEWPORT_ID as never)
		if (hud) return hud.coordinateLayerId
	}

	return FLEET_HUD_DOCUMENT_LAYER_ID
}

/**
 * Give this editor's core the layers it answers with, and the resolver that
 * answers. Idempotent; call it at editor mount.
 *
 * `document-page` is defined here rather than left to whichever HUD code path
 * happened to need it first. A resolver whose answers depend on what has run
 * already is not a model of anything.
 */
export function installTldaShapeLayers(editor: Editor): WMCore {
	const wm = getEditorWMCore(editor)

	ensureLayer(wm, FLEET_HUD_DOCUMENT_LAYER_ID, {
		parent: FLEET_HUD_ROOT_LAYER_ID,
		backing: {
			kind: 'page',
			editor: {
				pageToScreen: (point) => editor.pageToScreen(point),
				screenToPage: (point) => editor.screenToPage(point),
			},
		},
	})
	ensureFleetHudLayers(wm)

	wm.setShapeLayerResolver((shape) => tldaShapeLayerId(editor, shape))
	setShapeLayerReport(editor, () => shapeLayerReport(editor))
	return wm
}

/**
 * Every shape on the page, grouped by the layer it is in.
 *
 * This is the readout, and it is a DOM query rather than a rig: with the app
 * open, `window.__tlda_wm_core__.shapeLayerReport()` says which layer each
 * shape is in and how many are in each. AGENTS.md §"A browser is a last resort"
 * — "the question as to whether something is there can be satisfied by looking
 * at the fucking DOM".
 */
export function shapeLayerReport(editor: Editor) {
	const wm = getEditorWMCore(editor)
	const byLayer = new Map<LayerId, { count: number; types: Record<string, number>; sample: string[] }>()

	for (const shape of editor.getCurrentPageShapes() as TLShape[]) {
		const layerId = wm.layerIdOfShape(shape)
		let entry = byLayer.get(layerId)
		if (!entry) {
			entry = { count: 0, types: {}, sample: [] }
			byLayer.set(layerId, entry)
		}
		entry.count += 1
		entry.types[shape.type] = (entry.types[shape.type] ?? 0) + 1
		if (entry.sample.length < 5) entry.sample.push(shape.id)
	}

	return {
		layers: wm.layerCount(),
		overlayLayerId: FLEET_HUD_OVERLAY_LAYER_ID,
		hudViewportCoordinateLayerId: viewportCoordinateLayerId(FLEET_HUD_VIEWPORT_ID as never),
		hudProjecting: !!getRegisteredViewportLayer(editor, FLEET_HUD_VIEWPORT_ID as never),
		byLayer: Object.fromEntries(byLayer),
	}
}
