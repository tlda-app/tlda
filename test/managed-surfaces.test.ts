import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	createAnnotationViewerSurfaceRequest,
} from '../src/wm/annotation-viewer-surface.ts'
import {
	createTemporaryMarkdownSurfaceRequest,
	temporaryMarkdownShapeMeta,
} from '../src/wm/markdown-surface.ts'
import {
	createPageColumnHandleSurfaceRequest,
	createPageColumnSurfaceRequest,
	pageColumnHandleShapeMeta,
	pageColumnShapeMeta,
} from '../src/wm/page-column-surface.ts'
import { createLightboxSurfaceRequest } from '../src/wm/lightbox-surface.ts'

const chipRect = {
	left: 1180,
	top: 300,
	right: 1230,
	bottom: 320,
	width: 50,
	height: 20,
}

test('temporary markdown surface request carries explicit ids ownership policy and cleanup', () => {
	const request = createTemporaryMarkdownSurfaceRequest({
		shapeId: 'shape:fleet-markdown-chip-temp-column',
		bounds: { x: -50000, y: -49000, w: 800, h: 1200 },
		title: 'scratch.md',
		url: '/docs/fleet-markdown-chip-temp/index.html',
		owner: { userId: 'fleet:skip', deviceId: 'ipad' },
		sourceChatShapeId: 'shape:fleet-chat-a',
		sharedDocPath: '/tmp/scratch.md',
		authorId: 'fleet:agent',
	})

	assert.equal(request.kind, 'temporary-markdown')
	assert.equal(request.surfaceId, 'temporary-markdown:fleet-markdown-chip-temp-column')
	assert.equal(request.layerId, 'temporary-markdown-page:fleet-markdown-chip-temp-column')
	assert.deepEqual(request.owner, { userId: 'fleet:skip', deviceId: 'ipad' })
	assert.deepEqual(request.extent, { x: -50000, y: -49000, w: 800, h: 1200 })
	assert.deepEqual(request.cameraPolicy, { x: 'pan', y: 'pan', zoom: 'inherit' })
	assert.equal(request.hitPolicy, 'preview-readonly')
	assert.deepEqual(request.cleanup, {
		onClose: 'preserve-shape',
		onReplace: 'replace-existing-surface',
		onOwnerChange: 'remove-surface',
	})
	assert.deepEqual(temporaryMarkdownShapeMeta(request), {
		temporaryMarkdownColumn: true,
		managedSurfaceId: request.surfaceId,
		managedLayerId: request.layerId,
		managedHitPolicy: request.hitPolicy,
		managedCleanup: request.cleanup,
	})
})

test('annotation viewer surface request clamps chip-anchored placement and declares chrome hit policy', () => {
	const request = createAnnotationViewerSurfaceRequest({
		surfaceKey: 'temporary-markdown:fleet-markdown-chip-temp-column',
		bounds: { x: 10, y: 20, w: 800, h: 1200 },
		shapeIds: ['shape:fleet-markdown-chip-temp-column'],
		label: 'scratch.md',
		chipRect,
		useFullBounds: true,
		pinned: true,
		owner: { userId: 'fleet:skip', deviceId: 'ipad' },
		viewport: { w: 1280, h: 720 },
		size: { w: 650, h: 450 },
	})

	assert.equal(request.kind, 'annotation-viewer')
	assert.equal(request.surfaceId, 'annotation-viewer:temporary-markdown-fleet-markdown-chip-temp-column')
	assert.equal(request.layerId, 'annotation-viewer-panel:temporary-markdown-fleet-markdown-chip-temp-column')
	assert.deepEqual(request.cameraPolicy, { x: 'pin', y: 'pin', zoom: 'lock' })
	assert.equal(request.hitPolicy, 'chrome-catches-content-pans')
	assert.deepEqual(request.placement, {
		mode: 'chip-anchored',
		anchor: chipRect,
		left: 622,
		top: 85,
		margin: 8,
	})
	assert.deepEqual(request.extent, { x: 622, y: 85, w: 650, h: 450 })
	assert.deepEqual(request.persistence, { pinned: true, scope: 'session' })
	assert.equal(request.payload.useFullBounds, true)
	assert.deepEqual(request.payload.shapeIds, ['shape:fleet-markdown-chip-temp-column'])
})

test('page column page and handle requests carry managed ids owner policies and source', () => {
	const owner = { userId: 'fleet:skip', deviceId: 'ipad' }
	const page = createPageColumnSurfaceRequest({
		columnKey: '1-shadow-abcdef0',
		pageNum: 2,
		bounds: { x: 900, y: 1300, w: 800, h: 1035 },
		owner,
		source: 'shadow:bregman:abcdef012345',
	})
	const handle = createPageColumnHandleSurfaceRequest({
		columnKey: '1-shadow-abcdef0',
		bounds: { x: 960, y: -50000, w: 1, h: 99999 },
		owner,
		source: 'shadow:bregman:abcdef012345',
	})

	assert.equal(page.kind, 'page-column')
	assert.equal(page.surfaceId, 'page-column:1-shadow-abcdef0-p2')
	assert.equal(page.layerId, 'page-column-pages:1-shadow-abcdef0')
	assert.deepEqual(page.owner, owner)
	assert.deepEqual(page.cameraPolicy, { x: 'pan', y: 'pan', zoom: 'inherit' })
	assert.equal(page.hitPolicy, 'preview-readonly')
	assert.equal(page.cleanup.onClose, 'remove-surface')
	assert.equal(page.persistence.scope, 'session')
	assert.equal(page.payload.coordinateSpace, 'canvas-page')
	assert.equal(page.source, 'shadow:bregman:abcdef012345')
	assert.deepEqual(pageColumnShapeMeta(page), {
		managedSurfaceId: page.surfaceId,
		managedLayerId: page.layerId,
		managedKind: 'page-column',
		managedHitPolicy: 'preview-readonly',
		managedExtent: page.extent,
		managedPlacement: page.placement,
		managedCameraPolicy: page.cameraPolicy,
		managedCleanup: page.cleanup,
		managedOwner: owner,
		managedPersistence: page.persistence,
		managedSource: page.source,
		managedCoordinateSpace: 'canvas-page',
	})

	assert.equal(handle.kind, 'page-column-handle')
	assert.equal(handle.surfaceId, 'page-column-handle:1-shadow-abcdef0')
	assert.equal(handle.layerId, 'page-column-handle-chrome:1-shadow-abcdef0')
	assert.equal(handle.hitPolicy, 'chrome-catches-content-pans')
	assert.equal(handle.payload.coordinateSpace, 'canvas-page')
	assert.deepEqual(pageColumnHandleShapeMeta(handle), {
		managedSurfaceId: handle.surfaceId,
		managedLayerId: handle.layerId,
		managedKind: 'page-column-handle',
		managedHitPolicy: 'chrome-catches-content-pans',
		managedExtent: handle.extent,
		managedPlacement: handle.placement,
		managedCameraPolicy: handle.cameraPolicy,
		managedCleanup: handle.cleanup,
		managedOwner: owner,
		managedPersistence: handle.persistence,
		managedSource: handle.source,
		managedCoordinateSpace: 'canvas-page',
	})
})

test('lightbox request declares viewport modal policy and cleanup', () => {
	const owner = { userId: 'fleet:skip', deviceId: 'ipad' }
	const request = createLightboxSurfaceRequest({
		surfaceKey: 'shape:fleet-chat-a:chat-image:/api/upload/x.png',
		owner,
		source: 'shape:fleet-chat-a:chat-image:/api/upload/x.png',
		anchor: chipRect,
		viewport: { w: 1024, h: 768 },
	})

	assert.equal(request.kind, 'lightbox')
	assert.equal(request.surfaceId, 'lightbox:fleet-chat-a-chat-image--api-upload-x-png')
	assert.equal(request.layerId, 'lightbox-modal:fleet-chat-a-chat-image--api-upload-x-png')
	assert.deepEqual(request.owner, owner)
	assert.deepEqual(request.extent, { x: 0, y: 0, w: 1024, h: 768 })
	assert.equal(request.placement.mode, 'viewport-centered')
	assert.deepEqual(request.placement.anchor, chipRect)
	assert.deepEqual(request.cameraPolicy, { x: 'pin', y: 'pin', zoom: 'lock' })
	assert.equal(request.hitPolicy, 'modal-catches-all')
	assert.equal(request.cleanup.onClose, 'remove-surface')
	assert.deepEqual(request.persistence, { pinned: true, scope: 'session' })
	assert.equal(request.payload.coordinateSpace, 'viewport')
})
