import {
	createLayerOwner,
	createWMCore,
	type Camera,
	type Layer,
	type LayerOwner,
	type WMCore,
} from './wm-core.ts'
import { ensureViewLayer } from './editor-wm.ts'

export const FLEET_DOCVIEW_ROOT_LAYER_ID = 'screen'
export const FLEET_DOCVIEW_LAYER_ID = 'fleet-docview'
export const FLEET_DOCVIEW_VIEWPORT_PREFIX = 'wm:fleet-docview'

export interface FleetDocviewBounds {
	x: number
	y: number
	w: number
	h: number
}

export interface FleetDocviewLayerInput {
	shapeId: string
	bounds: FleetDocviewBounds
	pageBounds: FleetDocviewBounds
	panelWidth: number
	panelHeight: number
	userId?: string
	deviceId?: string
	source?: string | null
	wm?: WMCore
}

export interface FleetDocviewSurfaceState {
	rootLayerId: string
	layerId: string
	surfaceId: string
	viewportId: string
	wm: WMCore
	camera: Camera
	layer: Layer
	owner: LayerOwner
	bounds: FleetDocviewBounds
	pageBounds: FleetDocviewBounds
	source: string | null
	hitPolicy: 'chrome-catches-content-pans'
}

function slug(value: string) {
	return value.replace(/^shape:/, '').replace(/[^a-zA-Z0-9_-]/g, '-')
}

/**
 * The layer a docview shape draws into, derived from the shape's id alone.
 *
 * Exported because the layer outlives any one renderer of the shape: the fleet
 * HUD is a second viewport over the same store, so the component mounts twice
 * with this same id, and the removal therefore happens on shape deletion in
 * `installTldaShapeLayers` rather than on unmount. Both sides must agree on the
 * string, so there is one of it.
 */
export function fleetDocviewLayerId(shapeId: string) {
	return `${FLEET_DOCVIEW_LAYER_ID}:${slug(shapeId)}`
}

export function createFleetDocviewSurface({
	shapeId,
	bounds,
	pageBounds,
	panelWidth,
	panelHeight,
	userId = '',
	deviceId = '',
	source = null,
	wm = createWMCore({ rootLayerId: FLEET_DOCVIEW_ROOT_LAYER_ID }),
}: FleetDocviewLayerInput): FleetDocviewSurfaceState {
	const zoom = panelWidth / pageBounds.w
	const boundsCenter = bounds.y + bounds.h / 2
	const camera = {
		x: -pageBounds.x,
		y: -(boundsCenter - (panelHeight / zoom) / 2),
		z: zoom,
	}
	const surfaceId = fleetDocviewLayerId(shapeId)
	const viewportId = `${FLEET_DOCVIEW_VIEWPORT_PREFIX}:${slug(shapeId)}`
	ensureViewLayer(wm, surfaceId, {
		parent: FLEET_DOCVIEW_ROOT_LAYER_ID,
		policy: { x: 'pin', y: 'pin', zoom: 'lock' },
		transform: { x: camera.x, y: camera.y, scale: camera.z },
		layout: { axis: 'vertical', spacing: 0 },
	})
	const renderTransform = wm.transform(surfaceId)
	const owner = createLayerOwner(userId, deviceId)

	return {
		rootLayerId: wm.rootLayerId,
		layerId: surfaceId,
		surfaceId,
		viewportId,
		wm,
		camera: { x: renderTransform.x, y: renderTransform.y, z: renderTransform.scale },
		layer: wm.getLayer(surfaceId),
		owner,
		bounds,
		pageBounds,
		source,
		hitPolicy: 'chrome-catches-content-pans',
	}
}
