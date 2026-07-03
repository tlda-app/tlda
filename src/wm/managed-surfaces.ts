import type { JsonObject } from '@tldraw/utils'

export type ManagedSurfaceKind =
	| 'temporary-markdown'
	| 'annotation-viewer'
	| 'page-column'
	| 'page-column-handle'
	| 'lightbox'

export type ManagedSurfaceHitPolicy =
	| 'preview-readonly'
	| 'chrome-catches-content-pans'
	| 'modal-catches-all'

export interface ManagedSurfaceOwner {
	userId: string
	deviceId: string
}

export interface ManagedSurfaceRect {
	x: number
	y: number
	w: number
	h: number
}

export interface ManagedSurfaceClientRect {
	left: number
	top: number
	right: number
	bottom: number
	width: number
	height: number
}

export interface ManagedSurfacePlacement {
	mode: 'page' | 'chip-anchored' | 'viewport-centered'
	anchor?: ManagedSurfaceClientRect
	left?: number
	top?: number
	margin?: number
}

export interface ManagedSurfaceCleanup {
	onClose: 'remove-surface' | 'hide-surface' | 'preserve-shape'
	onReplace?: 'replace-existing-surface'
	onOwnerChange?: 'remove-surface'
}

export interface ManagedSurfaceCameraPolicy {
	x: 'pan' | 'pin'
	y: 'pan' | 'pin'
	zoom: 'inherit' | 'lock'
}

export interface ManagedSurfacePersistence {
	pinned: boolean
	scope: 'session' | 'room'
}

export interface ManagedSurfaceRequest<TPayload = unknown> {
	kind: ManagedSurfaceKind
	surfaceId: string
	layerId: string
	owner: ManagedSurfaceOwner
	extent: ManagedSurfaceRect
	placement: ManagedSurfacePlacement
	cameraPolicy: ManagedSurfaceCameraPolicy
	hitPolicy: ManagedSurfaceHitPolicy
	cleanup: ManagedSurfaceCleanup
	persistence: ManagedSurfacePersistence
	source: string | null
	payload: TPayload
}

export function createManagedSurfaceOwner(userId = '', deviceId = ''): ManagedSurfaceOwner {
	return { userId, deviceId }
}

export function requireManagedSurfaceOwner(
	owner: Partial<ManagedSurfaceOwner> | undefined,
	context = 'managed surface',
): ManagedSurfaceOwner {
	const resolved = createManagedSurfaceOwner(owner?.userId, owner?.deviceId)
	if (!resolved.userId || !resolved.deviceId) {
		throw new Error(`${context} requires owner userId and deviceId`)
	}
	return resolved
}

export function surfaceSlug(value: string): string {
	const slug = value.replace(/^shape:/, '').replace(/[^a-zA-Z0-9_-]/g, '-')
	return slug || 'surface'
}

export function clampChipAnchoredPlacement({
	chipRect,
	surfaceWidth,
	surfaceHeight,
	viewportWidth,
	viewportHeight,
	margin = 8,
}: {
	chipRect: ManagedSurfaceClientRect
	surfaceWidth: number
	surfaceHeight: number
	viewportWidth: number
	viewportHeight: number
	margin?: number
}): Required<Pick<ManagedSurfacePlacement, 'left' | 'top' | 'margin'>> {
	let left = chipRect.left
	if (left + surfaceWidth > viewportWidth - margin) left = viewportWidth - surfaceWidth - margin
	if (left < margin) left = margin

	const chipMid = chipRect.top + chipRect.height / 2
	let top = chipMid - surfaceHeight / 2
	if (top < margin) top = margin
	if (top + surfaceHeight > viewportHeight - margin) top = viewportHeight - surfaceHeight - margin

	return { left, top, margin }
}

function rectJson(rect: ManagedSurfaceRect): JsonObject {
	return { x: rect.x, y: rect.y, w: rect.w, h: rect.h }
}

function placementJson(placement: ManagedSurfacePlacement): JsonObject {
	return {
		mode: placement.mode,
		left: placement.left,
		top: placement.top,
		margin: placement.margin,
	}
}

function cameraPolicyJson(policy: ManagedSurfaceCameraPolicy): JsonObject {
	return { x: policy.x, y: policy.y, zoom: policy.zoom }
}

function cleanupJson(cleanup: ManagedSurfaceCleanup): JsonObject {
	return {
		onClose: cleanup.onClose,
		onReplace: cleanup.onReplace,
		onOwnerChange: cleanup.onOwnerChange,
	}
}

function ownerJson(owner: ManagedSurfaceOwner): JsonObject {
	return { userId: owner.userId, deviceId: owner.deviceId }
}

function persistenceJson(persistence: ManagedSurfacePersistence): JsonObject {
	return { pinned: persistence.pinned, scope: persistence.scope }
}

export function managedSurfaceShapeMeta(
	request: ManagedSurfaceRequest,
	options: { coordinateSpace?: string } = {},
): JsonObject {
	const meta: JsonObject = {
		managedSurfaceId: request.surfaceId,
		managedLayerId: request.layerId,
		managedKind: request.kind,
		managedHitPolicy: request.hitPolicy,
		managedExtent: rectJson(request.extent),
		managedPlacement: placementJson(request.placement),
		managedCameraPolicy: cameraPolicyJson(request.cameraPolicy),
		managedCleanup: cleanupJson(request.cleanup),
		managedOwner: ownerJson(request.owner),
		managedPersistence: persistenceJson(request.persistence),
		managedSource: request.source,
	}
	if (options.coordinateSpace) meta.managedCoordinateSpace = options.coordinateSpace
	return meta
}
