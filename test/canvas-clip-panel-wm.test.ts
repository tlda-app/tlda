import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	CANVAS_CLIP_PANEL_LAYER_ID,
	CANVAS_CLIP_ROOT_LAYER_ID,
	createCanvasClipPanelPlan,
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
	assert.deepEqual(plan.layer.policy, { x: 'pin', y: 'pin', zoom: 'lock' })
	assert.deepEqual(plan.layer.layout, { axis: 'vertical', spacing: 0 })
})
