import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	FLEET_HUD_OVERLAY_LAYER_ID,
	FLEET_HUD_ROOT_LAYER_ID,
	FLEET_HUD_VIEWPORT_ID,
	createFleetHudOverlayLayer,
} from '../src/wm/fleet-hud-layer.ts'
import {
	createFleetDocviewSurface,
} from '../src/wm/fleet-docview-layer.ts'

test('FleetHUD overlay camera is derived from a pinned WM layer', () => {
	const state = createFleetHudOverlayLayer({
		panOffset: -320,
		cameraY: 48,
	})

	assert.equal(state.rootLayerId, FLEET_HUD_ROOT_LAYER_ID)
	assert.equal(state.overlayLayerId, FLEET_HUD_OVERLAY_LAYER_ID)
	assert.equal(state.viewportId, FLEET_HUD_VIEWPORT_ID)
	assert.deepEqual(state.camera, { x: -320, y: 48, z: 1 })
	assert.deepEqual(state.layer.policy, { x: 'pin', y: 'pin', zoom: 'lock' })
	assert.deepEqual(state.layer.layout, { axis: 'vertical', spacing: 0 })
})

test('FleetHUD overlay layer preserves explicit zoom and layout metadata', () => {
	const state = createFleetHudOverlayLayer({
		panOffset: 12,
		cameraY: -9,
		zoom: 2,
		layout: { axis: 'horizontal', spacing: 24 },
	})

	assert.deepEqual(state.camera, { x: 12, y: -9, z: 2 })
	assert.deepEqual(state.layer.layout, { axis: 'horizontal', spacing: 24 })
})

test('Fleet docview surface derives a WM-managed viewport projection', () => {
	const state = createFleetDocviewSurface({
		shapeId: 'shape:docview-a',
		bounds: { x: 10, y: 120, w: 800, h: 240 },
		pageBounds: { x: 10, y: 0, w: 800, h: 1000 },
		panelWidth: 400,
		panelHeight: 300,
		userId: 'fleet:tester',
		deviceId: 'mini',
	})

	assert.equal(state.rootLayerId, 'screen')
	assert.equal(state.surfaceId, 'fleet-docview:docview-a')
	assert.equal(state.layerId, 'fleet-docview:docview-a')
	assert.equal(state.viewportId, 'wm:fleet-docview:docview-a')
	assert.deepEqual(state.camera, { x: -10, y: 60, z: 0.5 })
	assert.deepEqual(state.layer.policy, { x: 'pin', y: 'pin', zoom: 'lock' })
	assert.deepEqual(state.owner, { userId: 'fleet:tester', deviceId: 'mini' })
	assert.equal(state.source, null)
	assert.equal(state.hitPolicy, 'chrome-catches-content-pans')
})
