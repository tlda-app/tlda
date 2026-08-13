import {
	createLayerOwner,
	createWMCore,
	type Camera,
	type Layer,
	type LayerEffectiveTransform,
	type LayerLayout,
	type LayerOwner,
	type AxisTrackPolicy,
	type Point,
	type WMCore,
} from './wm-core.ts'
import { ensureLayer } from './editor-wm.ts'
import { crossAxis, type Axis } from '../shapes/document-flow-axis.ts'

export const FLEET_HUD_ROOT_LAYER_ID = 'screen'
export const FLEET_HUD_MAIN_CAMERA_LAYER_ID = 'main-camera'
export const FLEET_HUD_OVERLAY_LAYER_ID = 'fleet-overlay'
export const FLEET_HUD_DOCUMENT_LAYER_ID = 'document-page'
export const FLEET_HUD_VIEWPORT_ID = 'wm:fleet-hud'
export const FLEET_HUD_Z_BAND = 'hud-overlay'
export const FLEET_HUD_HIT_POLICY = 'fleet-shapes-catch-layout-gestures'
const FLEET_HUD_RESIZE_EDGE_PX = 10
const FLEET_HUD_RESIZE_CORNER_PX = 18

type FleetHudResizeCursor = 'ew-resize' | 'ns-resize' | 'nwse-resize' | 'nesw-resize'

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
	zBand: typeof FLEET_HUD_Z_BAND
	hitPolicy: typeof FLEET_HUD_HIT_POLICY
}

export interface FleetHudProjectionEditor {
	pageToScreen(point: Point): Point
	screenToPage(point: Point): Point
}

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
		flowAxis = 'y',
	}: {
		panOffset: number
		cameraY: number
		mainCamera?: Camera
		baseCamera?: Camera
		/** The axis this document's pages run along. See the note below. */
		flowAxis?: Axis
	},
): void {
	wm.setCamera(FLEET_HUD_MAIN_CAMERA_LAYER_ID, {
		x: mainCamera.x - baseCamera.x,
		y: mainCamera.y - baseCamera.y,
		z: mainCamera.z,
	})
	// Both axes of the main camera reach this layer; its policy says which one it
	// rides. Skip's rule: "the shapes on the HUD are in a fixed position relative
	// to the fucking screen in one direction and the slides in the other."
	//
	// 'pin' is screen-fixed, 'pan' is document-fixed, so the rule is one line:
	// pin the axis the pages flow along, pan the one across it. A paper flows
	// down and so holds a height on screen while riding sideways with the
	// document; a deck flows across and does the transpose. Neither is a case.
	ensureLayer(wm, FLEET_HUD_OVERLAY_LAYER_ID, {
		policy: {
			[flowAxis]: 'pin',
			[crossAxis(flowAxis)]: 'pan',
			zoom: 'lock',
		} as { x: AxisTrackPolicy; y: AxisTrackPolicy; zoom: 'lock' },
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
	return projectFleetHudDocumentNearEdgeWithWM(wm, editor, docPageLeft, 'x')
}

/** Where the document's near edge on `axis` sits on screen. One projection for
 *  either axis — which edge a layout anchors to is the caller's question, not a
 *  different piece of geometry. */
export function projectFleetHudDocumentNearEdgeWithWM(
	wm: WMCore,
	editor: FleetHudProjectionEditor,
	docPageNear: number,
	axis: Axis,
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
	const point = axis === 'x' ? { x: docPageNear, y: 0 } : { x: 0, y: docPageNear }
	return wm.translate(point, FLEET_HUD_DOCUMENT_LAYER_ID, FLEET_HUD_ROOT_LAYER_ID)[axis]
}

function fleetHudResizeCursorForPoint(rect: DOMRect, x: number, y: number): FleetHudResizeCursor | null {
	const nearLeft = x >= rect.left - FLEET_HUD_RESIZE_EDGE_PX && x <= rect.left + FLEET_HUD_RESIZE_EDGE_PX
	const nearRight = x >= rect.right - FLEET_HUD_RESIZE_EDGE_PX && x <= rect.right + FLEET_HUD_RESIZE_EDGE_PX
	const nearTop = y >= rect.top - FLEET_HUD_RESIZE_EDGE_PX && y <= rect.top + FLEET_HUD_RESIZE_EDGE_PX
	const nearBottom = y >= rect.bottom - FLEET_HUD_RESIZE_EDGE_PX && y <= rect.bottom + FLEET_HUD_RESIZE_EDGE_PX

	if (
		(nearLeft && nearTop && Math.abs(y - rect.top) <= FLEET_HUD_RESIZE_CORNER_PX) ||
		(nearRight && nearBottom && Math.abs(y - rect.bottom) <= FLEET_HUD_RESIZE_CORNER_PX)
	) {
		return 'nwse-resize'
	}
	if (
		(nearRight && nearTop && Math.abs(y - rect.top) <= FLEET_HUD_RESIZE_CORNER_PX) ||
		(nearLeft && nearBottom && Math.abs(y - rect.bottom) <= FLEET_HUD_RESIZE_CORNER_PX)
	) {
		return 'nesw-resize'
	}

	const withinVerticalEdge = y >= rect.top + FLEET_HUD_RESIZE_EDGE_PX && y <= rect.bottom - FLEET_HUD_RESIZE_EDGE_PX
	const withinHorizontalEdge = x >= rect.left + FLEET_HUD_RESIZE_EDGE_PX && x <= rect.right - FLEET_HUD_RESIZE_EDGE_PX
	if ((nearLeft || nearRight) && withinVerticalEdge) return 'ew-resize'
	if ((nearTop || nearBottom) && withinHorizontalEdge) return 'ns-resize'
	return null
}

function findFleetHudResizeShape(root: HTMLElement, x: number, y: number): HTMLElement | null {
	const shapes = root.querySelectorAll<HTMLElement>('.tl-shape.fleet-drag-mode[data-shape-id]:not(.tl-shape-background)')
	for (const shape of shapes) {
		const rect = shape.getBoundingClientRect()
		if (
			x >= rect.left - FLEET_HUD_RESIZE_EDGE_PX &&
			x <= rect.right + FLEET_HUD_RESIZE_EDGE_PX &&
			y >= rect.top - FLEET_HUD_RESIZE_EDGE_PX &&
			y <= rect.bottom + FLEET_HUD_RESIZE_EDGE_PX
		) {
			return shape
		}
	}
	return null
}

function setFleetHudResizeCursor(shape: HTMLElement, cursor: FleetHudResizeCursor | null): void {
	const targets = [
		shape,
		...shape.querySelectorAll<HTMLElement>('.tl-html-container, .fleet-shape, .fleet-shape *'),
	]
	for (const target of targets) {
		if (cursor) target.style.setProperty('cursor', cursor, 'important')
		else target.style.removeProperty('cursor')
	}
}

export function installFleetHudResizeCursor(root: HTMLElement): () => void {
	let lastShape: HTMLElement | null = null
	let raf = 0

	const clear = () => {
		if (!lastShape) return
		setFleetHudResizeCursor(lastShape, null)
		lastShape = null
	}

	const update = (clientX: number, clientY: number) => {
		if (!document.body.classList.contains('fleet-hud-fleet-selected')) {
			clear()
			return
		}
		const shape = findFleetHudResizeShape(root, clientX, clientY)
		if (!shape) {
			clear()
			return
		}
		const cursor = fleetHudResizeCursorForPoint(shape.getBoundingClientRect(), clientX, clientY)
		if (!cursor) {
			clear()
			return
		}
		if (lastShape && lastShape !== shape) setFleetHudResizeCursor(lastShape, null)
		lastShape = shape
		setFleetHudResizeCursor(shape, cursor)
	}

	const onMove = (event: PointerEvent | MouseEvent) => {
		if (!(event.target instanceof Element) || !root.contains(event.target)) {
			clear()
			return
		}
		cancelAnimationFrame(raf)
		raf = requestAnimationFrame(() => update(event.clientX, event.clientY))
	}

	root.addEventListener('pointermove', onMove, true)
	root.addEventListener('mousemove', onMove, true)
	root.addEventListener('pointerleave', clear)
	return () => {
		cancelAnimationFrame(raf)
		root.removeEventListener('pointermove', onMove, true)
		root.removeEventListener('mousemove', onMove, true)
		root.removeEventListener('pointerleave', clear)
		clear()
	}
}
