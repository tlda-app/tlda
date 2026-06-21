import { createWMCore, type Camera, type Layer, type LayerLayout } from './wm-core'

export const FLEET_HUD_ROOT_LAYER_ID = 'screen'
export const FLEET_HUD_OVERLAY_LAYER_ID = 'fleet-overlay'
export const FLEET_HUD_VIEWPORT_ID = 'wm:fleet-hud'

export interface FleetHudLayerInput {
	panOffset: number
	cameraY: number
	zoom?: number
	layout?: LayerLayout
}

export interface FleetHudLayerState {
	rootLayerId: string
	overlayLayerId: string
	viewportId: string
	camera: Camera
	layer: Layer
}

export function createFleetHudOverlayLayer({
	panOffset,
	cameraY,
	zoom = 1,
	layout = { axis: 'vertical', spacing: 0 },
}: FleetHudLayerInput): FleetHudLayerState {
	const wm = createWMCore({ rootLayerId: FLEET_HUD_ROOT_LAYER_ID })
	wm.defineLayer(FLEET_HUD_OVERLAY_LAYER_ID, {
		parent: FLEET_HUD_ROOT_LAYER_ID,
		policy: { x: 'pin', y: 'pin', zoom: 'lock' },
		camera: { x: panOffset, y: cameraY, z: zoom },
		layout,
	})

	return {
		rootLayerId: wm.rootLayerId,
		overlayLayerId: FLEET_HUD_OVERLAY_LAYER_ID,
		viewportId: FLEET_HUD_VIEWPORT_ID,
		camera: wm.camera(FLEET_HUD_OVERLAY_LAYER_ID),
		layer: wm.getLayer(FLEET_HUD_OVERLAY_LAYER_ID),
	}
}
