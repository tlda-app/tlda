import type { Editor, TLViewportId } from 'tldraw'
import type { Camera, Layer } from './wm-core.ts'
import type { WMCore } from './wm-core.ts'

export const CANVAS_CLIP_ROOT_LAYER_ID = 'screen'
export const CANVAS_CLIP_PANEL_LAYER_ID = 'canvas-clip-panel'

export const CANVAS_CLIP_VIEWPORT_CAPABILITIES = {
	namedViewport: true,
	independentCamera: true,
	shapePredicate: true,
	disableCulling: true,
	frameAwareCoordinates: true,
	clippedRendering: true,
} as const

export interface CanvasClipWMSurface {
	wm: WMCore
	layerId: string
	surfaceId?: string
}

export function getOptionalCanvasClipViewport(editor: Editor, viewportId: TLViewportId) {
	try {
		return editor.getViewport(viewportId)
	} catch (error) {
		if (error instanceof Error && error.message.includes('No viewport registered')) {
			return null
		}
		throw error
	}
}

export function sameCanvasClipCamera(a: Camera | null, b: Camera) {
	return !!a && a.x === b.x && a.y === b.y && a.z === b.z
}

export function canvasClipSurfaceCamera(surface: CanvasClipWMSurface, fullViewport: boolean): Camera {
	const transform = fullViewport
		? surface.wm.transform(surface.layerId)
		: surface.wm.transformInfo(surface.layerId).local
	return { x: transform.x, y: transform.y, z: transform.scale }
}

export function setCanvasClipSurfaceCamera(surface: CanvasClipWMSurface, camera: Camera): void {
	const layer = surface.wm.getLayer(surface.layerId)
	if (layer.policy.x === 'pin' && layer.policy.y === 'pin' && layer.policy.zoom === 'lock') {
		surface.wm.setTransform(surface.layerId, { x: camera.x, y: camera.y, scale: camera.z })
		surface.wm.setCamera(surface.layerId, { x: 0, y: 0, z: 1 })
		return
	}
	surface.wm.setCamera(surface.layerId, camera)
}

export function shouldRenderLockedFleetViewportShape(shape: {
	type?: string
	props?: unknown
}, owner?: { userId?: string | null; deviceId?: string | null }): boolean {
	const type = shape.type
	if (!type?.startsWith('fleet-')) return false

	// Transient drag previews do not carry ownership props. They still need to
	// render inside the locked HUD viewport that owns the active drag gesture.
	if (type === 'fleet-pill') return true

	const props = shape.props as { userId?: unknown; deviceId?: unknown } | undefined
	if (!props?.userId || !props?.deviceId) return false
	if (!owner?.userId || !owner?.deviceId) return false
	return props.userId === owner.userId && props.deviceId === owner.deviceId
}

export interface CanvasClipBounds {
	x: number
	y: number
	w: number
	h: number
}

export interface CanvasClipPanelPlanInput {
	bounds: CanvasClipBounds
	panelWidth: number
	viewportHeight: number
	maxHeightFraction: number
	lockCamera?: boolean
	minVisibleLines?: number
	lineHeightEstimate?: number
}

export interface CanvasClipPanelPlan {
	rootLayerId: string
	panelLayerId: string
	camera: Camera
	layer: Layer
	visibleBounds: CanvasClipBounds
	zoom: number
	viewportHeight: number
	yOffset: number
}

export function createCanvasClipPanelPlan({
	bounds,
	panelWidth,
	viewportHeight,
	maxHeightFraction,
	lockCamera = false,
	minVisibleLines = 0,
	lineHeightEstimate = 0,
}: CanvasClipPanelPlanInput): CanvasClipPanelPlan {
	const zoom = panelWidth / bounds.w
	const contentScreenH = bounds.h * zoom
	const minScreenH = minVisibleLines * lineHeightEstimate * zoom
	const cappedViewportH = Math.min(contentScreenH, viewportHeight * maxHeightFraction)
	const panelViewportH = Math.max(minScreenH, cappedViewportH)
	const yOffset = panelViewportH > contentScreenH
		? (panelViewportH - contentScreenH) / (2 * zoom)
		: 0
	const camera = { x: -bounds.x, y: -(bounds.y - yOffset), z: zoom }

	const layer: Layer = {
		id: CANVAS_CLIP_PANEL_LAYER_ID,
		parent: CANVAS_CLIP_ROOT_LAYER_ID,
		policy: lockCamera
			? { x: 'pin', y: 'pin', zoom: 'lock' }
			: { x: 'pan', y: 'pan', zoom: 'inherit' },
		transform: lockCamera
			? { x: camera.x, y: camera.y, scale: camera.z }
			: { x: 0, y: 0, scale: 1 },
		camera: lockCamera
			? { x: 0, y: 0, z: 1 }
			: camera,
		cameraPanUnit: 'layer',
		backing: { kind: 'frame' },
		layout: { axis: 'vertical', spacing: 0 },
	}

	return {
		rootLayerId: CANVAS_CLIP_ROOT_LAYER_ID,
		panelLayerId: CANVAS_CLIP_PANEL_LAYER_ID,
		camera,
		layer,
		visibleBounds: {
			x: bounds.x,
			y: bounds.y - yOffset,
			w: panelWidth / zoom,
			h: panelViewportH / zoom,
		},
		zoom,
		viewportHeight: panelViewportH,
		yOffset,
	}
}
