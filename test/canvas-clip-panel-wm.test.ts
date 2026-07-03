import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	CANVAS_CLIP_VIEWPORT_CAPABILITIES,
	CANVAS_CLIP_PANEL_LAYER_ID,
	CANVAS_CLIP_ROOT_LAYER_ID,
	canvasClipSurfaceCamera,
	createCanvasClipPanelPlan,
	getOptionalCanvasClipViewport,
	sameCanvasClipCamera,
	setCanvasClipSurfaceCamera,
} from '../src/wm/canvas-clip-panel.ts'

test('CanvasClipPanel WM helper preserves bounds-to-camera calculation', () => {
	const plan = createCanvasClipPanelPlan({
		bounds: { x: 10, y: 20, w: 200, h: 50 },
		panelWidth: 600,
		viewportHeight: 1000,
		maxHeightFraction: 0.4,
		minVisibleLines: 5,
		lineHeightEstimate: 14,
	})

	assert.deepEqual(plan.camera, { x: -10, y: -10, z: 3 })
	assert.deepEqual(plan.visibleBounds, { x: 10, y: 10, w: 200, h: 70 })
	assert.equal(plan.rootLayerId, CANVAS_CLIP_ROOT_LAYER_ID)
	assert.equal(plan.panelLayerId, CANVAS_CLIP_PANEL_LAYER_ID)
	assert.deepEqual(plan.layer.policy, { x: 'pan', y: 'pan', zoom: 'inherit' })
})

test('CanvasClipPanel WM helper marks locked panels as pinned lock-zoom layers', () => {
	const plan = createCanvasClipPanelPlan({
		bounds: { x: -4, y: 8, w: 100, h: 100 },
		panelWidth: 500,
		viewportHeight: 900,
		maxHeightFraction: 0.4,
		lockCamera: true,
		minVisibleLines: 5,
		lineHeightEstimate: 14,
	})

	assert.deepEqual(plan.camera, { x: 4, y: -8, z: 5 })
	assert.deepEqual(plan.layer.transform, { x: 4, y: -8, scale: 5 })
	assert.deepEqual(plan.layer.camera, { x: 0, y: 0, z: 1 })
	assert.deepEqual(plan.layer.policy, { x: 'pin', y: 'pin', zoom: 'lock' })
	assert.deepEqual(plan.layer.layout, { axis: 'vertical', spacing: 0 })
})

test('CanvasClipPanel WM helper exposes fork-facing viewport capabilities', () => {
	assert.deepEqual(CANVAS_CLIP_VIEWPORT_CAPABILITIES, {
		namedViewport: true,
		independentCamera: true,
		shapePredicate: true,
		disableCulling: true,
		frameAwareCoordinates: true,
		clippedRendering: true,
	})
})

test('CanvasClipPanel WM helper owns optional viewport lookup and camera helpers', () => {
	const viewport = { camera: { x: 1, y: 2, z: 3 } }
	const editor = {
		getViewport: (id: string) => {
			if (id === 'missing') throw new Error('No viewport registered: missing')
			if (id === 'boom') throw new Error('other failure')
			return viewport
		},
	}
	assert.equal(getOptionalCanvasClipViewport(editor as any, 'ok' as any), viewport)
	assert.equal(getOptionalCanvasClipViewport(editor as any, 'missing' as any), null)
	assert.throws(() => getOptionalCanvasClipViewport(editor as any, 'boom' as any), /other failure/)

	assert.equal(sameCanvasClipCamera({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3 }), true)
	assert.equal(sameCanvasClipCamera({ x: 1, y: 2, z: 3 }, { x: 1, y: 9, z: 3 }), false)

	const calls: unknown[] = []
	const surface = {
		layerId: 'panel',
		wm: {
			transform: () => ({ x: 10, y: 20, scale: 2 }),
			transformInfo: () => ({ local: { x: 30, y: 40, scale: 3 } }),
			getLayer: () => ({ policy: { x: 'pin', y: 'pin', zoom: 'lock' } }),
			setTransform: (...args: unknown[]) => calls.push(['setTransform', ...args]),
			setCamera: (...args: unknown[]) => calls.push(['setCamera', ...args]),
		},
	}
	assert.deepEqual(canvasClipSurfaceCamera(surface as any, true), { x: 10, y: 20, z: 2 })
	assert.deepEqual(canvasClipSurfaceCamera(surface as any, false), { x: 30, y: 40, z: 3 })
	setCanvasClipSurfaceCamera(surface as any, { x: 5, y: 6, z: 7 })
	assert.deepEqual(calls, [
		['setTransform', 'panel', { x: 5, y: 6, scale: 7 }],
		['setCamera', 'panel', { x: 0, y: 0, z: 1 }],
	])
})
