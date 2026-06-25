import { createWMCore, type Camera, type Layer } from './wm-core.ts'

export const WM_VIEWPORT_ROOT_LAYER_ID = 'screen'
export const WM_PICTURE_IN_PICTURE_LAYER_ID = 'picture-in-picture'
export const WM_PICTURE_IN_PICTURE_VIEWPORT_ID = 'wm:picture-in-picture'

export interface WMPictureInPictureLayerInput {
	sourceCamera: Camera
	offsetX?: number
	offsetY?: number
	zoomScale?: number
	minZoom?: number
	maxZoom?: number
}

export interface WMViewportLayerState {
	rootLayerId: string
	viewportLayerId: string
	viewportId: string
	camera: Camera
	layer: Layer
}

function clamp(value: number, min: number, max: number) {
	return Math.min(max, Math.max(min, value))
}

export function createWMPictureInPictureLayer({
	sourceCamera,
	offsetX = 180,
	offsetY = 120,
	zoomScale = 1.35,
	minZoom = 0.05,
	maxZoom = 8,
}: WMPictureInPictureLayerInput): WMViewportLayerState {
	const sourceZoom = Math.max(sourceCamera.z, 0.001)
	const camera = {
		x: sourceCamera.x - offsetX / sourceZoom,
		y: sourceCamera.y - offsetY / sourceZoom,
		z: clamp(sourceCamera.z * zoomScale, minZoom, maxZoom),
	}
	const wm = createWMCore({ rootLayerId: WM_VIEWPORT_ROOT_LAYER_ID })
	wm.defineLayer(WM_PICTURE_IN_PICTURE_LAYER_ID, {
		parent: WM_VIEWPORT_ROOT_LAYER_ID,
		policy: { x: 'pan', y: 'pan', zoom: 'own' },
		camera,
		layout: { axis: 'vertical', spacing: 0 },
	})

	return {
		rootLayerId: wm.rootLayerId,
		viewportLayerId: WM_PICTURE_IN_PICTURE_LAYER_ID,
		viewportId: WM_PICTURE_IN_PICTURE_VIEWPORT_ID,
		camera: wm.camera(WM_PICTURE_IN_PICTURE_LAYER_ID),
		layer: wm.getLayer(WM_PICTURE_IN_PICTURE_LAYER_ID),
	}
}
