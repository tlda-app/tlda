import {
	createManagedSurfaceOwner,
	surfaceSlug,
	type ManagedSurfaceOwner,
	type ManagedSurfaceRect,
	type ManagedSurfaceRequest,
} from './managed-surfaces.ts'

export const TEMP_MARKDOWN_SURFACE_PREFIX = 'temporary-markdown'
export const TEMP_MARKDOWN_LAYER_PREFIX = 'temporary-markdown-page'

export interface TemporaryMarkdownSurfaceInput {
	shapeId: string
	bounds: ManagedSurfaceRect
	title: string
	url: string
	owner?: Partial<ManagedSurfaceOwner>
	sourceChatShapeId?: string
	sharedDocPath?: string
	authorId?: string
}

export interface TemporaryMarkdownSurfacePayload {
	shapeId: string
	title: string
	url: string
	sourceChatShapeId?: string
	sharedDocPath?: string
	authorId?: string
	temporaryMarkdownColumn: true
}

export function createTemporaryMarkdownSurfaceRequest({
	shapeId,
	bounds,
	title,
	url,
	owner,
	sourceChatShapeId,
	sharedDocPath,
	authorId,
}: TemporaryMarkdownSurfaceInput): ManagedSurfaceRequest<TemporaryMarkdownSurfacePayload> {
	const slug = surfaceSlug(shapeId)
	return {
		kind: 'temporary-markdown',
		surfaceId: `${TEMP_MARKDOWN_SURFACE_PREFIX}:${slug}`,
		layerId: `${TEMP_MARKDOWN_LAYER_PREFIX}:${slug}`,
		owner: createManagedSurfaceOwner(owner?.userId, owner?.deviceId),
		extent: { ...bounds },
		placement: {
			mode: 'page',
			left: bounds.x,
			top: bounds.y,
			margin: 0,
		},
		cameraPolicy: { x: 'pan', y: 'pan', zoom: 'inherit' },
		hitPolicy: 'preview-readonly',
		cleanup: {
			onClose: 'preserve-shape',
			onReplace: 'replace-existing-surface',
			onOwnerChange: 'remove-surface',
		},
		persistence: { pinned: false, scope: 'session' },
		source: sourceChatShapeId ?? sharedDocPath ?? null,
		payload: {
			shapeId,
			title,
			url,
			sourceChatShapeId,
			sharedDocPath,
			authorId,
			temporaryMarkdownColumn: true,
		},
	}
}

export function temporaryMarkdownShapeMeta(
	request: ManagedSurfaceRequest<TemporaryMarkdownSurfacePayload>,
) {
	return {
		temporaryMarkdownColumn: true,
		managedSurfaceId: request.surfaceId,
		managedLayerId: request.layerId,
		managedHitPolicy: request.hitPolicy,
		managedCleanup: request.cleanup,
	}
}
