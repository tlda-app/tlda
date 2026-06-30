import {
	clampChipAnchoredPlacement,
	createManagedSurfaceOwner,
	surfaceSlug,
	type ManagedSurfaceClientRect,
	type ManagedSurfaceOwner,
	type ManagedSurfaceRect,
	type ManagedSurfaceRequest,
} from './managed-surfaces.ts'

export const ANNOTATION_VIEWER_SURFACE_PREFIX = 'annotation-viewer'
export const ANNOTATION_VIEWER_LAYER_PREFIX = 'annotation-viewer-panel'

export interface AnnotationViewerSurfaceInput {
	surfaceKey: string
	bounds: ManagedSurfaceRect
	shapeIds?: string[]
	label?: string
	color?: string
	chipRect: ManagedSurfaceClientRect
	useFullBounds?: boolean
	pinned?: boolean
	bulletIdx?: number
	owner?: Partial<ManagedSurfaceOwner>
	source?: string | null
	viewport?: { w: number; h: number }
	size?: { w: number; h: number }
	centerOnAnchor?: boolean
}

export interface AnnotationViewerSurfacePayload {
	bounds: ManagedSurfaceRect
	shapeIds: string[]
	label?: string
	color?: string
	chipRect: ManagedSurfaceClientRect
	useFullBounds: boolean
	pinned: boolean
	bulletIdx?: number
}

function requireManagedSurfaceOwner(owner?: Partial<ManagedSurfaceOwner>): ManagedSurfaceOwner {
	const resolved = createManagedSurfaceOwner(owner?.userId, owner?.deviceId)
	if (!resolved.userId || !resolved.deviceId) {
		throw new Error('managed annotation viewer surface requires owner userId and deviceId')
	}
	return resolved
}

export function createAnnotationViewerSurfaceRequest({
	surfaceKey,
	bounds,
	shapeIds = [],
	label,
	color,
	chipRect,
	useFullBounds = false,
	pinned = false,
	bulletIdx,
	owner,
	source = null,
	viewport = { w: 1200, h: 800 },
	size = { w: 650, h: 450 },
	centerOnAnchor = false,
}: AnnotationViewerSurfaceInput): ManagedSurfaceRequest<AnnotationViewerSurfacePayload> {
	const slug = surfaceSlug(surfaceKey)
	const resolvedOwner = requireManagedSurfaceOwner(owner)
	const placement = clampChipAnchoredPlacement({
		chipRect,
		surfaceWidth: size.w,
		surfaceHeight: size.h,
		viewportWidth: viewport.w,
		viewportHeight: viewport.h,
	})
	const centeredLeft = Math.max(placement.margin, Math.min(
		Math.round(centerOnAnchor
			? (viewport.w - size.w) / 2
			: placement.left),
		viewport.w - size.w - placement.margin,
	))
	const centeredTop = Math.max(placement.margin, Math.min(
		Math.round(centerOnAnchor
			? (viewport.h - size.h) / 2
			: placement.top),
		viewport.h - size.h - placement.margin,
	))
	return {
		kind: 'annotation-viewer',
		surfaceId: `${ANNOTATION_VIEWER_SURFACE_PREFIX}:${slug}`,
		layerId: `${ANNOTATION_VIEWER_LAYER_PREFIX}:${slug}`,
		owner: resolvedOwner,
		extent: { x: centeredLeft, y: centeredTop, w: size.w, h: size.h },
		placement: {
			mode: centerOnAnchor ? 'viewport-centered' : 'chip-anchored',
			anchor: chipRect,
			left: centeredLeft,
			top: centeredTop,
			margin: placement.margin,
		},
		cameraPolicy: { x: 'pin', y: 'pin', zoom: 'lock' },
		hitPolicy: 'chrome-catches-content-pans',
		cleanup: {
			onClose: 'hide-surface',
			onOwnerChange: 'remove-surface',
		},
		persistence: { pinned, scope: 'session' },
		source,
		payload: {
			bounds: { ...bounds },
			shapeIds,
			label,
			color,
			chipRect,
			useFullBounds,
			pinned,
			bulletIdx,
		},
	}
}

export function dispatchAnnotationViewerSurfaceRequest(input: AnnotationViewerSurfaceInput) {
	const request = createAnnotationViewerSurfaceRequest({
		...input,
		viewport: input.viewport ?? (
			typeof window !== 'undefined'
				? { w: window.innerWidth, h: window.innerHeight }
				: { w: 1200, h: 800 }
		),
	})
	window.dispatchEvent(new CustomEvent('wm-managed-surface-request', {
		detail: { request },
	}))
	return request
}

export function dispatchAnnotationViewerDismiss() {
	window.dispatchEvent(new CustomEvent('wm-managed-surface-dismiss', {
		detail: { kind: 'annotation-viewer' },
	}))
}

export function dispatchManagedAnnotationViewerRequest(
	input: AnnotationViewerSurfaceInput,
	target: Window = window,
) {
	const request = createAnnotationViewerSurfaceRequest(input)
	target.dispatchEvent(new CustomEvent('wm-managed-surface-request', {
		detail: { request },
	}))
	return request
}

export function dispatchManagedAnnotationViewerHide(target: Window = window) {
	target.dispatchEvent(new CustomEvent('wm-managed-surface-dismiss', {
		detail: { kind: 'annotation-viewer' },
	}))
}
