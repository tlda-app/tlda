import { createWMCore, type Camera, type Layer } from './wm-core.ts'

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
}

export interface FleetDocviewSurfaceState {
	rootLayerId: string
	layerId: string
	surfaceId: string
	viewportId: string
	camera: Camera
	layer: Layer
	owner: {
		userId: string
		deviceId: string
	}
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
	const wm = createWMCore({ rootLayerId: FLEET_DOCVIEW_ROOT_LAYER_ID })
	wm.defineLayer(surfaceId, {
		parent: FLEET_DOCVIEW_ROOT_LAYER_ID,
		policy: { x: 'pin', y: 'pin', zoom: 'lock' },
		camera,
		layout: { axis: 'vertical', spacing: 0 },
	})

	return {
		rootLayerId: wm.rootLayerId,
		layerId: surfaceId,
		surfaceId,
		viewportId,
		camera: wm.camera(surfaceId),
		layer: wm.getLayer(surfaceId),
		owner: { userId, deviceId },
		bounds,
		pageBounds,
		source,
		hitPolicy: 'chrome-catches-content-pans',
	}
}
