export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[]
export type JsonObject = { [key: string]: JsonValue }

export type ManagedSurfaceKind = string

export type ManagedSurfaceHitPolicy =
	| 'preview-readonly'
	| 'chrome-catches-content-pans'
	| 'modal-catches-all'

export type ManagedSurfaceEventRegion = 'content' | 'chrome' | 'outside'
export type ManagedSurfaceEventOwner = 'content' | 'surface' | 'underlay'

/** Resolve pointer ownership without host-specific selectors or input-device branches. */
export function managedSurfaceEventOwner(
	policy: ManagedSurfaceHitPolicy,
	region: ManagedSurfaceEventRegion,
): ManagedSurfaceEventOwner {
	if (region === 'outside') return policy === 'modal-catches-all' ? 'surface' : 'underlay'
	if (policy === 'modal-catches-all') return 'surface'
	if (policy === 'chrome-catches-content-pans' && region === 'content') return 'content'
	return 'surface'
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

export interface ManagedSurfacePersistence<TScope extends string = string> {
	pinned: boolean
	scope: TScope
}

export interface ManagedSurfaceRequest<
	TPayload = unknown,
	TKind extends ManagedSurfaceKind = ManagedSurfaceKind,
	TOwner extends JsonObject = JsonObject,
	TScope extends string = string,
> {
	kind: TKind
	surfaceId: string
	layerId: string
	owner: TOwner
	extent: ManagedSurfaceRect
	placement: ManagedSurfacePlacement
	cameraPolicy: ManagedSurfaceCameraPolicy
	hitPolicy: ManagedSurfaceHitPolicy
	cleanup: ManagedSurfaceCleanup
	replacementGroup?: string
	persistence: ManagedSurfacePersistence<TScope>
	source: string | null
	payload: TPayload
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
	const json: JsonObject = { mode: placement.mode }
	if (placement.left !== undefined) json.left = placement.left
	if (placement.top !== undefined) json.top = placement.top
	if (placement.margin !== undefined) json.margin = placement.margin
	return json
}

function cameraPolicyJson(policy: ManagedSurfaceCameraPolicy): JsonObject {
	return { x: policy.x, y: policy.y, zoom: policy.zoom }
}

function cleanupJson(cleanup: ManagedSurfaceCleanup): JsonObject {
	const json: JsonObject = { onClose: cleanup.onClose }
	if (cleanup.onReplace !== undefined) json.onReplace = cleanup.onReplace
	if (cleanup.onOwnerChange !== undefined) json.onOwnerChange = cleanup.onOwnerChange
	return json
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
		managedOwner: request.owner,
		managedPersistence: persistenceJson(request.persistence),
		managedSource: request.source,
	}
	if (options.coordinateSpace) meta.managedCoordinateSpace = options.coordinateSpace
	return meta
}

export interface ManagedSurfaceLifecycleHost<TOwner extends JsonObject, TScope extends string> {
	sameOwner(a: TOwner, b: TOwner): boolean
	show(request: ManagedSurfaceRequest<unknown, string, TOwner, TScope>): void
	remove(request: ManagedSurfaceRequest<unknown, string, TOwner, TScope>): void
	hide(request: ManagedSurfaceRequest<unknown, string, TOwner, TScope>): void
	preserve(request: ManagedSurfaceRequest<unknown, string, TOwner, TScope>): void
	applyPlacement(request: ManagedSurfaceRequest<unknown, string, TOwner, TScope>): void
	applyCameraPolicy(request: ManagedSurfaceRequest<unknown, string, TOwner, TScope>): void
	applyHitPolicy(request: ManagedSurfaceRequest<unknown, string, TOwner, TScope>): void
	persist(request: ManagedSurfaceRequest<unknown, string, TOwner, TScope>): void
	clearPersistence(request: ManagedSurfaceRequest<unknown, string, TOwner, TScope>): void
}

/** Enforces the lifecycle vocabulary carried by managed-surface requests. */
export class ManagedSurfaceLifecycle<TOwner extends JsonObject, TScope extends string> {
	private readonly active = new Map<string, ManagedSurfaceRequest<unknown, string, TOwner, TScope>>()
	private readonly host: ManagedSurfaceLifecycleHost<TOwner, TScope>

	constructor(host: ManagedSurfaceLifecycleHost<TOwner, TScope>) {
		this.host = host
	}

	request<TPayload, TKind extends string>(request: ManagedSurfaceRequest<TPayload, TKind, TOwner, TScope>) {
		for (const active of this.active.values()) {
			if (!request.replacementGroup || active.replacementGroup !== request.replacementGroup || active.surfaceId === request.surfaceId) continue
			if (active.cleanup.onReplace !== 'replace-existing-surface') {
				throw new Error(`Managed surface kind "${request.kind}" is already active.`)
			}
			this.close(active.surfaceId)
		}
		const previous = this.active.get(request.surfaceId)
		if (previous && !this.host.sameOwner(previous.owner, request.owner)) {
			if (previous.cleanup.onOwnerChange !== 'remove-surface') {
				throw new Error(`Managed surface "${request.surfaceId}" cannot change owner.`)
			}
			this.host.remove(previous)
		}
		this.active.set(request.surfaceId, request as ManagedSurfaceRequest<unknown, string, TOwner, TScope>)
		this.host.applyPlacement(request as ManagedSurfaceRequest<unknown, string, TOwner, TScope>)
		this.host.applyCameraPolicy(request as ManagedSurfaceRequest<unknown, string, TOwner, TScope>)
		this.host.applyHitPolicy(request as ManagedSurfaceRequest<unknown, string, TOwner, TScope>)
		this.host.show(request as ManagedSurfaceRequest<unknown, string, TOwner, TScope>)
		if (request.persistence.pinned) this.host.persist(request as ManagedSurfaceRequest<unknown, string, TOwner, TScope>)
		return request
	}

	closeKind(kind: string): boolean {
		const surfaceIds = [...this.active.values()]
			.filter(active => active.kind === kind)
			.map(active => active.surfaceId)
		for (const surfaceId of surfaceIds) this.close(surfaceId)
		return surfaceIds.length > 0
	}

	close(surfaceId: string): boolean {
		const request = this.active.get(surfaceId)
		if (!request) return false
		this.active.delete(surfaceId)
		if (request.cleanup.onClose === 'remove-surface') this.host.remove(request)
		else if (request.cleanup.onClose === 'hide-surface') this.host.hide(request)
		else this.host.preserve(request)
		if (request.persistence.pinned) this.host.clearPersistence(request)
		return true
	}

	get(surfaceId: string) {
		return this.active.get(surfaceId)
	}

	hitPolicy(surfaceId: string): ManagedSurfaceHitPolicy | undefined {
		return this.active.get(surfaceId)?.hitPolicy
	}
}
