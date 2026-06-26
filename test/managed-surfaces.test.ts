import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	createAnnotationViewerSurfaceRequest,
	createTemporaryMarkdownAnnotationViewerRequest,
} from '../src/wm/annotation-viewer-surface.ts'
import {
	createTemporaryMarkdownSurfaceRequest,
	temporaryMarkdownShapeMeta,
} from '../src/wm/markdown-surface.ts'

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

test('temporary markdown annotation viewer request links the preview surface as source', () => {
	const markdown = createTemporaryMarkdownSurfaceRequest({
		shapeId: 'shape:fleet-markdown-chip-temp-column',
		bounds: { x: -50000, y: -49000, w: 800, h: 1200 },
		title: 'scratch.md',
		url: '/docs/fleet-markdown-chip-temp/index.html',
	})
	const viewer = createTemporaryMarkdownAnnotationViewerRequest(markdown, {
		label: 'scratch.md',
		chipRect,
		viewport: { w: 1280, h: 720 },
	})

	assert.equal(viewer.source, markdown.surfaceId)
	assert.equal(viewer.persistence.pinned, true)
	assert.equal(viewer.cleanup.onClose, 'remove-surface')
	assert.equal(viewer.payload.useFullBounds, true)
	assert.deepEqual(viewer.payload.bounds, markdown.extent)
	assert.deepEqual(viewer.payload.shapeIds, [markdown.payload.shapeId])
})
