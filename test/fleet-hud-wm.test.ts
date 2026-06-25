import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	FLEET_HUD_OVERLAY_LAYER_ID,
	FLEET_HUD_DOCUMENT_LAYER_ID,
	FLEET_HUD_HIT_POLICY,
	FLEET_HUD_ROOT_LAYER_ID,
	FLEET_HUD_VIEWPORT_ID,
	FLEET_HUD_Z_BAND,
	createFleetHudOverlayLayer,
	type FleetHudProjectionEditor,
	projectFleetHudDocumentLeft,
} from '../src/wm/fleet-hud-layer.ts'
import {
	createFleetDocviewSurface,
} from '../src/wm/fleet-docview-layer.ts'

test('FleetHUD overlay camera is derived from a pan-x pinned-y WM layer', () => {
	const state = createFleetHudOverlayLayer({
		panOffset: -320,
		cameraY: 48,
		userId: 'fleet:tester',
		deviceId: 'mini',
	})

	assert.equal(state.rootLayerId, FLEET_HUD_ROOT_LAYER_ID)
	assert.equal(state.overlayLayerId, FLEET_HUD_OVERLAY_LAYER_ID)
	assert.equal(state.documentLayerId, FLEET_HUD_DOCUMENT_LAYER_ID)
	assert.equal(state.viewportId, FLEET_HUD_VIEWPORT_ID)
	assert.deepEqual(state.camera, { x: -320, y: 48, z: 1 })
	assert.deepEqual(state.layer.policy, { x: 'pan', y: 'pin', zoom: 'lock' })
	assert.deepEqual(state.layer.layout, { axis: 'vertical', spacing: 0 })
	assert.deepEqual(state.owner, { userId: 'fleet:tester', deviceId: 'mini' })
	assert.deepEqual(state.membership, {
		layerId: FLEET_HUD_OVERLAY_LAYER_ID,
		userId: 'fleet:tester',
		deviceId: 'mini',
	})
	assert.equal(state.zBand, FLEET_HUD_Z_BAND)
	assert.equal(state.hitPolicy, FLEET_HUD_HIT_POLICY)
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

test('FleetHUD document-left projection crosses the WM document layer', () => {
	const calls: Array<[string, { x: number; y: number }]> = []
	const editor: FleetHudProjectionEditor = {
		pageToScreen(point: { x: number; y: number }) {
			calls.push(['pageToScreen', point])
			return { x: point.x + 450, y: point.y + 25 }
		},
		screenToPage(point: { x: number; y: number }) {
			calls.push(['screenToPage', point])
			return { x: point.x - 450, y: point.y - 25 }
		},
	}

	assert.equal(projectFleetHudDocumentLeft(editor, -120), 330)
	assert.deepEqual(calls, [['pageToScreen', { x: -120, y: 0 }]])
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
