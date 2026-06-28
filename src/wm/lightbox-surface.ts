import {
	createManagedSurfaceOwner,
	surfaceSlug,
	type ManagedSurfaceClientRect,
	type ManagedSurfaceOwner,
	type ManagedSurfaceRequest,
} from './managed-surfaces.ts'

export interface LightboxSurfaceInput {
	surfaceKey: string
	owner?: Partial<ManagedSurfaceOwner>
	source: string | null
	anchor?: ManagedSurfaceClientRect
	viewport?: { w: number; h: number }
}

export interface LightboxSurfacePayload {
	surfaceKey: string
	coordinateSpace: 'viewport'
	source: string | null
}

function requireLightboxOwner(owner?: Partial<ManagedSurfaceOwner>): ManagedSurfaceOwner {
	const resolved = createManagedSurfaceOwner(owner?.userId, owner?.deviceId)
	if (!resolved.userId || !resolved.deviceId) {
		throw new Error('managed lightbox surface requires owner userId and deviceId')
	}
	return resolved
}

export function createLightboxSurfaceRequest({
	surfaceKey,
	owner,
	source,
	anchor,
	viewport = typeof window !== 'undefined' ? { w: window.innerWidth, h: window.innerHeight } : { w: 0, h: 0 },
}: LightboxSurfaceInput): ManagedSurfaceRequest<LightboxSurfacePayload> {
	const slug = surfaceSlug(surfaceKey)
	const resolvedOwner = requireLightboxOwner(owner)
	return {
		kind: 'lightbox',
		surfaceId: `lightbox:${slug}`,
		layerId: `lightbox-modal:${slug}`,
		owner: resolvedOwner,
		extent: { x: 0, y: 0, w: viewport.w, h: viewport.h },
		placement: {
			mode: 'viewport-centered',
			anchor,
			left: 0,
			top: 0,
			margin: 0,
		},
		cameraPolicy: { x: 'pin', y: 'pin', zoom: 'lock' },
		hitPolicy: 'modal-catches-all',
		cleanup: {
			onClose: 'remove-surface',
			onReplace: 'replace-existing-surface',
			onOwnerChange: 'remove-surface',
		},
		persistence: { pinned: true, scope: 'session' },
		source,
		payload: { surfaceKey, coordinateSpace: 'viewport', source },
	}
}
