import type { Camera, Layer } from './wm-core.ts'

export const CANVAS_CLIP_ROOT_LAYER_ID = 'screen'
export const CANVAS_CLIP_PANEL_LAYER_ID = 'canvas-clip-panel'

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
