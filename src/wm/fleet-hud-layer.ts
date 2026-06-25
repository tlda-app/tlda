import { createWMCore, type Camera, type Layer, type LayerLayout, type Point } from './wm-core.ts'

export const FLEET_HUD_ROOT_LAYER_ID = 'screen'
export const FLEET_HUD_OVERLAY_LAYER_ID = 'fleet-overlay'
export const FLEET_HUD_DOCUMENT_LAYER_ID = 'document-page'
export const FLEET_HUD_VIEWPORT_ID = 'wm:fleet-hud'
export const FLEET_HUD_Z_BAND = 'hud-overlay'
export const FLEET_HUD_HIT_POLICY = 'fleet-shapes-catch-layout-gestures'

export interface FleetHudLayerInput {
	panOffset: number
	cameraY: number
	zoom?: number
	layout?: LayerLayout
	userId?: string
	deviceId?: string
}

export interface FleetHudLayerState {
	rootLayerId: string
	overlayLayerId: string
	documentLayerId: string
	viewportId: string
	camera: Camera
	layer: Layer
	owner: {
		userId: string
		deviceId: string
	}
	membership: {
		layerId: string
		userId: string
		deviceId: string
	}
	zBand: typeof FLEET_HUD_Z_BAND
	hitPolicy: typeof FLEET_HUD_HIT_POLICY
}

export interface FleetHudProjectionEditor {
	pageToScreen(point: Point): Point
	screenToPage(point: Point): Point
}

export function createFleetHudOverlayLayer({
	panOffset,
	cameraY,
	zoom = 1,
	layout = { axis: 'vertical', spacing: 0 },
	userId = '',
	deviceId = '',
}: FleetHudLayerInput): FleetHudLayerState {
	const wm = createWMCore({ rootLayerId: FLEET_HUD_ROOT_LAYER_ID })
	wm.defineLayer(FLEET_HUD_OVERLAY_LAYER_ID, {
		parent: FLEET_HUD_ROOT_LAYER_ID,
		policy: { x: 'pan', y: 'pin', zoom: 'lock' },
		camera: { x: panOffset, y: cameraY, z: zoom },
		layout,
	})

	return {
		rootLayerId: wm.rootLayerId,
		overlayLayerId: FLEET_HUD_OVERLAY_LAYER_ID,
		documentLayerId: FLEET_HUD_DOCUMENT_LAYER_ID,
		viewportId: FLEET_HUD_VIEWPORT_ID,
		camera: wm.camera(FLEET_HUD_OVERLAY_LAYER_ID),
		layer: wm.getLayer(FLEET_HUD_OVERLAY_LAYER_ID),
		owner: { userId, deviceId },
		membership: {
			layerId: FLEET_HUD_OVERLAY_LAYER_ID,
			userId,
			deviceId,
		},
		zBand: FLEET_HUD_Z_BAND,
		hitPolicy: FLEET_HUD_HIT_POLICY,
	}
}

export function projectFleetHudDocumentLeft(editor: FleetHudProjectionEditor, docPageLeft: number): number {
	const wm = createWMCore({ rootLayerId: FLEET_HUD_ROOT_LAYER_ID })
	wm.defineLayer(FLEET_HUD_DOCUMENT_LAYER_ID, {
		parent: FLEET_HUD_ROOT_LAYER_ID,
		backing: {
			kind: 'page',
			editor: {
				pageToScreen: (point: Point) => editor.pageToScreen(point),
				screenToPage: (point: Point) => editor.screenToPage(point),
			},
		},
	})
	return wm.translate({ x: docPageLeft, y: 0 }, FLEET_HUD_DOCUMENT_LAYER_ID, FLEET_HUD_ROOT_LAYER_ID).x
}
