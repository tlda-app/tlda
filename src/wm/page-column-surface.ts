import {
	managedSurfaceShapeMeta,
	requireManagedSurfaceOwner,
	surfaceSlug,
	type ManagedSurfaceOwner,
	type ManagedSurfaceRect,
	type ManagedSurfaceRequest,
} from './managed-surfaces.ts'
import type { JsonObject } from '@tldraw/utils'

export const PAGE_COLUMN_SURFACE_PREFIX = 'page-column'
export const PAGE_COLUMN_HANDLE_SURFACE_PREFIX = 'page-column-handle'

export interface PageColumnSurfaceInput {
	columnKey: string
	pageNum: number
	bounds: ManagedSurfaceRect
	owner?: Partial<ManagedSurfaceOwner>
	source: string
}

export interface PageColumnSurfacePayload {
	columnKey: string
	pageNum: number
	coordinateSpace: 'canvas-page'
	source: string
}

export function createPageColumnSurfaceRequest({
	columnKey,
	pageNum,
	bounds,
	owner,
	source,
}: PageColumnSurfaceInput): ManagedSurfaceRequest<PageColumnSurfacePayload> {
	const slug = surfaceSlug(`${columnKey}-p${pageNum}`)
	const resolvedOwner = requireManagedSurfaceOwner(owner, 'managed page-column surface')
	return {
		kind: 'page-column',
		surfaceId: `${PAGE_COLUMN_SURFACE_PREFIX}:${slug}`,
		layerId: `${PAGE_COLUMN_SURFACE_PREFIX}-pages:${surfaceSlug(columnKey)}`,
		owner: resolvedOwner,
		extent: { ...bounds },
		placement: { mode: 'page', left: bounds.x, top: bounds.y, margin: 0 },
		cameraPolicy: { x: 'pan', y: 'pan', zoom: 'inherit' },
		hitPolicy: 'preview-readonly',
		cleanup: {
			onClose: 'remove-surface',
			onReplace: 'replace-existing-surface',
			onOwnerChange: 'remove-surface',
		},
		persistence: { pinned: false, scope: 'session' },
		source,
		payload: { columnKey, pageNum, coordinateSpace: 'canvas-page', source },
	}
}

export interface PageColumnHandleSurfaceInput {
	columnKey: string
	bounds: ManagedSurfaceRect
	owner?: Partial<ManagedSurfaceOwner>
	source: string
}

export interface PageColumnHandleSurfacePayload {
	columnKey: string
	coordinateSpace: 'canvas-page'
	source: string
}

export function createPageColumnHandleSurfaceRequest({
	columnKey,
	bounds,
	owner,
	source,
}: PageColumnHandleSurfaceInput): ManagedSurfaceRequest<PageColumnHandleSurfacePayload> {
	const slug = surfaceSlug(columnKey)
	const resolvedOwner = requireManagedSurfaceOwner(owner, 'managed page-column surface')
	return {
		kind: 'page-column-handle',
		surfaceId: `${PAGE_COLUMN_HANDLE_SURFACE_PREFIX}:${slug}`,
		layerId: `${PAGE_COLUMN_HANDLE_SURFACE_PREFIX}-chrome:${slug}`,
		owner: resolvedOwner,
		extent: { ...bounds },
		placement: { mode: 'page', left: bounds.x, top: bounds.y, margin: 0 },
		cameraPolicy: { x: 'pan', y: 'pan', zoom: 'inherit' },
		hitPolicy: 'chrome-catches-content-pans',
		cleanup: {
			onClose: 'remove-surface',
			onReplace: 'replace-existing-surface',
			onOwnerChange: 'remove-surface',
		},
		persistence: { pinned: false, scope: 'session' },
		source,
		payload: { columnKey, coordinateSpace: 'canvas-page', source },
	}
}

export function pageColumnShapeMeta(request: ManagedSurfaceRequest<PageColumnSurfacePayload>): JsonObject {
	return managedSurfaceShapeMeta(request, { coordinateSpace: request.payload.coordinateSpace })
}

export function pageColumnHandleShapeMeta(request: ManagedSurfaceRequest<PageColumnHandleSurfacePayload>): JsonObject {
	return managedSurfaceShapeMeta(request, { coordinateSpace: request.payload.coordinateSpace })
}
