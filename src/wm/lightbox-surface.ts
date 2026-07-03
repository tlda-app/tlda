import {
	requireManagedSurfaceOwner,
	surfaceSlug,
	type ManagedSurfaceClientRect,
	type ManagedSurfaceOwner,
	type ManagedSurfaceRequest,
} from './managed-surfaces.ts'
import type { TldaManagedSurfaceKind } from './tlda-managed-surface-kinds.ts'

export const LIGHTBOX_SURFACE_PREFIX = 'lightbox'
export const LIGHTBOX_LAYER_PREFIX = 'lightbox-modal'
export type LightboxSurfaceKind = Extract<TldaManagedSurfaceKind, typeof LIGHTBOX_SURFACE_PREFIX>

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

export function createLightboxSurfaceRequest({
	surfaceKey,
	owner,
	source,
	anchor,
	viewport = typeof window !== 'undefined' ? { w: window.innerWidth, h: window.innerHeight } : { w: 0, h: 0 },
}: LightboxSurfaceInput): ManagedSurfaceRequest<LightboxSurfacePayload, LightboxSurfaceKind> {
	const slug = surfaceSlug(surfaceKey)
	const resolvedOwner = requireManagedSurfaceOwner(owner, 'managed lightbox surface')
	return {
		kind: LIGHTBOX_SURFACE_PREFIX,
		surfaceId: `${LIGHTBOX_SURFACE_PREFIX}:${slug}`,
		layerId: `${LIGHTBOX_LAYER_PREFIX}:${slug}`,
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
