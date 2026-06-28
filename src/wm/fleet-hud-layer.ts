import {
	createLayerMembership,
	createLayerOwner,
	createWMCore,
	type Camera,
	type Layer,
	type LayerEffectiveTransform,
	type LayerLayout,
	type LayerMembership,
	type LayerOwner,
	type Point,
	type WMCore,
} from './wm-core.ts'
import { ensureLayer } from './editor-wm.ts'

export const FLEET_HUD_ROOT_LAYER_ID = 'screen'
export const FLEET_HUD_MAIN_CAMERA_LAYER_ID = 'main-camera'
export const FLEET_HUD_OVERLAY_LAYER_ID = 'fleet-overlay'
export const FLEET_HUD_DOCUMENT_LAYER_ID = 'document-page'
const FLEET_HUD_DROP_OVERLAY_LAYER_ID = 'fleet-overlay:drop-page-adapter'
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
	transform: LayerEffectiveTransform
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

export function createFleetHudWMCore({
	panOffset = 0,
	cameraY = 0,
	zoom = 1,
	layout = { axis: 'vertical', spacing: 0 },
}: Partial<Pick<FleetHudLayerInput, 'panOffset' | 'cameraY' | 'zoom' | 'layout'>> = {}): WMCore {
	const wm = createWMCore({ rootLayerId: FLEET_HUD_ROOT_LAYER_ID })
	ensureFleetHudLayers(wm, { panOffset, cameraY, zoom, layout })
	return wm
}

export function ensureFleetHudLayers(
	wm: WMCore,
	{
		panOffset = 0,
		cameraY = 0,
		zoom = 1,
		layout = { axis: 'vertical', spacing: 0 },
	}: Partial<Pick<FleetHudLayerInput, 'panOffset' | 'cameraY' | 'zoom' | 'layout'>> = {},
): WMCore {
	ensureLayer(wm, FLEET_HUD_MAIN_CAMERA_LAYER_ID, {
		parent: FLEET_HUD_ROOT_LAYER_ID,
		policy: { x: 'pan', y: 'pan', zoom: 'inherit' },
		camera: { x: 0, y: 0, z: zoom },
		cameraPanUnit: 'screen',
	})
	ensureLayer(wm, FLEET_HUD_OVERLAY_LAYER_ID, {
		parent: FLEET_HUD_MAIN_CAMERA_LAYER_ID,
		policy: { x: 'pan', y: 'pin', zoom: 'lock' },
		transform: { x: panOffset, y: cameraY, scale: 1 },
		camera: { x: 0, y: 0, z: 1 },
		layout,
	})
	return wm
}

export function configureFleetHudOverlayLayer(
	wm: WMCore,
	{
		panOffset,
		cameraY,
		mainCamera = { x: 0, y: 0, z: 1 },
		baseCamera = mainCamera,
	}: {
		panOffset: number
		cameraY: number
		mainCamera?: Camera
		baseCamera?: Camera
	},
): void {
	wm.setCamera(FLEET_HUD_MAIN_CAMERA_LAYER_ID, {
		x: mainCamera.x - baseCamera.x,
		y: mainCamera.y - baseCamera.y,
		z: mainCamera.z,
	})
	wm.setTransform(FLEET_HUD_OVERLAY_LAYER_ID, { x: panOffset, y: cameraY, scale: 1 })
	wm.setCamera(FLEET_HUD_OVERLAY_LAYER_ID, { x: 0, y: 0, z: 1 })
}

export function readFleetHudOverlayLayer(
	wm: WMCore,
	{
		userId = '',
		deviceId = '',
	}: Pick<FleetHudLayerInput, 'userId' | 'deviceId'> = {},
): FleetHudLayerState {
	const transform = wm.transform(FLEET_HUD_OVERLAY_LAYER_ID)
	const transformInfo = wm.transformInfo(FLEET_HUD_OVERLAY_LAYER_ID)
	const owner = createLayerOwner(userId, deviceId)

	return {
		rootLayerId: wm.rootLayerId,
		overlayLayerId: FLEET_HUD_OVERLAY_LAYER_ID,
		documentLayerId: FLEET_HUD_DOCUMENT_LAYER_ID,
		viewportId: FLEET_HUD_VIEWPORT_ID,
		camera: { x: transform.x, y: transform.y, z: transform.scale },
		layer: wm.getLayer(FLEET_HUD_OVERLAY_LAYER_ID),
		transform: transformInfo,
		owner,
		membership: createLayerMembership(FLEET_HUD_OVERLAY_LAYER_ID, owner),
		zBand: FLEET_HUD_Z_BAND,
		hitPolicy: FLEET_HUD_HIT_POLICY,
	}
}

export function projectFleetHudDocumentLeft(editor: FleetHudProjectionEditor, docPageLeft: number): number {
	return projectFleetHudDocumentLeftWithWM(createWMCore({ rootLayerId: FLEET_HUD_ROOT_LAYER_ID }), editor, docPageLeft)
}

export function projectFleetHudDocumentLeftWithWM(
	wm: WMCore,
	editor: FleetHudProjectionEditor,
	docPageLeft: number,
): number {
	ensureLayer(wm, FLEET_HUD_DOCUMENT_LAYER_ID, {
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
	return translateFleetHudDropPointWithWM(
		createWMCore({ rootLayerId: FLEET_HUD_ROOT_LAYER_ID }),
		overlayEditor,
		documentEditor,
		overlayPagePoint,
	)
}

export function translateFleetHudDropPointWithWM(
	wm: WMCore,
	overlayEditor: FleetHudDropEditor,
	documentEditor: FleetHudDropEditor,
	overlayPagePoint: Point,
): Point {
	ensureLayer(wm, FLEET_HUD_DROP_OVERLAY_LAYER_ID, {
		parent: FLEET_HUD_ROOT_LAYER_ID,
		backing: {
			kind: 'page',
			editor: {
				pageToScreen: (point: Point) => overlayEditor.pageToScreen(point),
				screenToPage: (point: Point) => overlayEditor.screenToPage(point),
			},
		},
	})
	ensureLayer(wm, FLEET_HUD_DOCUMENT_LAYER_ID, {
		parent: FLEET_HUD_ROOT_LAYER_ID,
		backing: {
			kind: 'page',
			editor: {
				pageToScreen: (point: Point) => documentEditor.pageToScreen(point),
				screenToPage: (point: Point) => documentEditor.screenToPage(point),
			},
		},
	})
	return wm.translate(overlayPagePoint, FLEET_HUD_DROP_OVERLAY_LAYER_ID, FLEET_HUD_DOCUMENT_LAYER_ID)
}
