import {
	createLayerMembership,
	createLayerOwner,
	createWMCore,
	type Camera,
	type Layer,
	type LayerLayout,
	type LayerMembership,
	type LayerOwner,
	type Point,
} from './wm-core.ts'

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
	owner: LayerOwner
	membership: LayerMembership
	zBand: typeof FLEET_HUD_Z_BAND
	hitPolicy: typeof FLEET_HUD_HIT_POLICY
}

export interface FleetHudProjectionEditor {
	pageToScreen(point: Point): Point
	screenToPage(point: Point): Point
}

export type FleetHudDropEditor = FleetHudProjectionEditor

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
	const owner = createLayerOwner(userId, deviceId)

	return {
		rootLayerId: wm.rootLayerId,
		overlayLayerId: FLEET_HUD_OVERLAY_LAYER_ID,
		documentLayerId: FLEET_HUD_DOCUMENT_LAYER_ID,
		viewportId: FLEET_HUD_VIEWPORT_ID,
		camera: wm.camera(FLEET_HUD_OVERLAY_LAYER_ID),
		layer: wm.getLayer(FLEET_HUD_OVERLAY_LAYER_ID),
		owner,
		membership: createLayerMembership(FLEET_HUD_OVERLAY_LAYER_ID, owner),
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

export function translateFleetHudDropPoint(
	overlayEditor: FleetHudDropEditor,
	documentEditor: FleetHudDropEditor,
	overlayPagePoint: Point,
): Point {
	const wm = createWMCore({ rootLayerId: FLEET_HUD_ROOT_LAYER_ID })
	wm.defineLayer(FLEET_HUD_OVERLAY_LAYER_ID, {
		parent: FLEET_HUD_ROOT_LAYER_ID,
		backing: {
			kind: 'page',
			editor: {
				pageToScreen: (point: Point) => overlayEditor.pageToScreen(point),
				screenToPage: (point: Point) => overlayEditor.screenToPage(point),
			},
		},
	})
	wm.defineLayer(FLEET_HUD_DOCUMENT_LAYER_ID, {
		parent: FLEET_HUD_ROOT_LAYER_ID,
		backing: {
			kind: 'page',
			editor: {
				pageToScreen: (point: Point) => documentEditor.pageToScreen(point),
				screenToPage: (point: Point) => documentEditor.screenToPage(point),
			},
		},
	})
	return wm.translate(overlayPagePoint, FLEET_HUD_OVERLAY_LAYER_ID, FLEET_HUD_DOCUMENT_LAYER_ID)
}
