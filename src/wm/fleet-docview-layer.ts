import {
	createLayerMembership,
	createLayerOwner,
	createWMCore,
	type Camera,
	type Layer,
	type LayerMembership,
	type LayerOwner,
	type WMCore,
} from './wm-core.ts'
import { ensureLayer } from './editor-wm.ts'

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
	membership: LayerMembership
	bounds: FleetDocviewBounds
	pageBounds: FleetDocviewBounds
	source: string | null
	hitPolicy: 'chrome-catches-content-pans'
}

function slug(value: string) {
	return value.replace(/^shape:/, '').replace(/[^a-zA-Z0-9_-]/g, '-')
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
	const surfaceId = `${FLEET_DOCVIEW_LAYER_ID}:${slug(shapeId)}`
	const viewportId = `${FLEET_DOCVIEW_VIEWPORT_PREFIX}:${slug(shapeId)}`
	ensureLayer(wm, surfaceId, {
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
		membership: createLayerMembership(surfaceId, owner),
		bounds,
		pageBounds,
		source,
		hitPolicy: 'chrome-catches-content-pans',
	}
}
