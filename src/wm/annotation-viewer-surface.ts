import {
	clampChipAnchoredPlacement,
	dismissManagedSurface,
	requireManagedSurfaceOwner,
	requestManagedSurface,
	surfaceSlug,
	type ManagedSurfaceClientRect,
	type ManagedSurfaceOwner,
	type ManagedSurfaceRect,
	type ManagedSurfaceRequest,
} from './managed-surfaces.ts'
import type { TldaManagedSurfaceKind } from './tlda-managed-surface-kinds.ts'

export const ANNOTATION_VIEWER_SURFACE_PREFIX = 'annotation-viewer'
export const ANNOTATION_VIEWER_LAYER_PREFIX = 'annotation-viewer-panel'
export type AnnotationViewerSurfaceKind = Extract<TldaManagedSurfaceKind, typeof ANNOTATION_VIEWER_SURFACE_PREFIX>

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
}: AnnotationViewerSurfaceInput): ManagedSurfaceRequest<AnnotationViewerSurfacePayload, AnnotationViewerSurfaceKind, ManagedSurfaceOwner, 'session'> {
	const slug = surfaceSlug(surfaceKey)
	const resolvedOwner = requireManagedSurfaceOwner(owner, 'managed annotation viewer surface')
	const margin = 8
	const resolvedSize = {
		w: Math.min(size.w, Math.max(1, viewport.w - margin * 2)),
		h: Math.min(size.h, Math.max(1, viewport.h - margin * 2)),
	}
	const placement = clampChipAnchoredPlacement({
		chipRect,
		surfaceWidth: resolvedSize.w,
		surfaceHeight: resolvedSize.h,
		viewportWidth: viewport.w,
		viewportHeight: viewport.h,
		margin,
	})
	const centeredLeft = Math.max(placement.margin, Math.min(
		Math.round(centerOnAnchor
			? (viewport.w - resolvedSize.w) / 2
			: placement.left),
		viewport.w - resolvedSize.w - placement.margin,
	))
	const centeredTop = Math.max(placement.margin, Math.min(
		Math.round(centerOnAnchor
			? (viewport.h - resolvedSize.h) / 2
			: placement.top),
		viewport.h - resolvedSize.h - placement.margin,
	))
	return {
		kind: 'annotation-viewer',
		surfaceId: `${ANNOTATION_VIEWER_SURFACE_PREFIX}:${slug}`,
		layerId: `${ANNOTATION_VIEWER_LAYER_PREFIX}:${slug}`,
		owner: resolvedOwner,
		extent: { x: centeredLeft, y: centeredTop, w: resolvedSize.w, h: resolvedSize.h },
		placement: {
			mode: centerOnAnchor ? 'viewport-centered' : 'chip-anchored',
			anchor: chipRect,
			left: centeredLeft,
			top: centeredTop,
			margin: placement.margin,
		},
		cameraPolicy: { x: 'pin', y: 'pin', zoom: 'lock' },
		hitPolicy: pinned ? 'chrome-catches-content-pans' : 'preview-readonly',
		cleanup: {
			onClose: 'hide-surface',
			onReplace: 'replace-existing-surface',
			onOwnerChange: 'remove-surface',
		},
		replacementGroup: ANNOTATION_VIEWER_SURFACE_PREFIX,
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
	return requestManagedSurface(window, request)
}

export function dispatchAnnotationViewerDismiss() {
	dismissManagedSurface(window, 'annotation-viewer')
}

export function dispatchManagedAnnotationViewerRequest(
	input: AnnotationViewerSurfaceInput,
	target: Window = window,
) {
	const request = createAnnotationViewerSurfaceRequest(input)
	return requestManagedSurface(target, request)
}

export function dispatchManagedAnnotationViewerHide(target: Window = window) {
	dismissManagedSurface(target, 'annotation-viewer')
}
