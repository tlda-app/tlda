import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	FLEET_HUD_OVERLAY_LAYER_ID,
	FLEET_HUD_DOCUMENT_LAYER_ID,
	FLEET_HUD_HIT_POLICY,
	FLEET_HUD_MAIN_CAMERA_LAYER_ID,
	FLEET_HUD_ROOT_LAYER_ID,
	FLEET_HUD_VIEWPORT_ID,
	FLEET_HUD_Z_BAND,
	configureFleetHudOverlayLayer,
	createFleetHudWMCore,
	readFleetHudOverlayLayer,
	type FleetHudProjectionEditor,
	projectFleetHudDocumentLeft,
	translateFleetHudDropPoint,
} from '../src/wm/fleet-hud-layer.ts'
import {
	createFleetDocviewSurface,
} from '../src/wm/fleet-docview-layer.ts'
import { createWMCore } from '../src/wm/wm-core.ts'

test('FleetHUD overlay camera is derived from a pan-x pinned-y WM layer', () => {
	const wm = createFleetHudWMCore({
		panOffset: -320,
		cameraY: 48,
	})
	const state = readFleetHudOverlayLayer(wm, {
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
	const wm = createFleetHudWMCore({
		panOffset: 12,
		cameraY: -9,
		zoom: 2,
		layout: { axis: 'horizontal', spacing: 24 },
	})
	const state = readFleetHudOverlayLayer(wm)

	assert.deepEqual(state.camera, { x: 12, y: -9, z: 1 })
	assert.deepEqual(state.layer.camera, { x: 0, y: 0, z: 1 })
	assert.deepEqual(wm.getLayer(FLEET_HUD_MAIN_CAMERA_LAYER_ID).camera, { x: 0, y: 0, z: 2 })
	assert.deepEqual(state.layer.layout, { axis: 'horizontal', spacing: 24 })
})

test('FleetHUD WM policy maps main pan to x while pinning y and locking zoom', () => {
	const wm = createFleetHudWMCore({ panOffset: 12, cameraY: -9, zoom: 1 })

	configureFleetHudOverlayLayer(wm, {
		panOffset: 12,
		cameraY: -9,
		baseCamera: { x: 100, y: 200, z: 2 },
		mainCamera: { x: 115, y: 260, z: 2 },
	})

	assert.deepEqual(readFleetHudOverlayLayer(wm).camera, { x: 42, y: -9, z: 1 })
})

test('FleetHUD overlay traverses a real parent chain and differs from local transform', () => {
	const wm = createFleetHudWMCore({ panOffset: 12, cameraY: -9, zoom: 2 })

	configureFleetHudOverlayLayer(wm, {
		panOffset: 12,
		cameraY: -9,
		baseCamera: { x: 100, y: 200, z: 2 },
		mainCamera: { x: 115, y: 260, z: 2 },
	})

	const state = readFleetHudOverlayLayer(wm)
	assert.deepEqual(state.transform.parentChain, [FLEET_HUD_ROOT_LAYER_ID, FLEET_HUD_MAIN_CAMERA_LAYER_ID])
	assert.deepEqual(state.transform.local, { x: 12, y: -9, scale: 1 })
	assert.deepEqual(state.transform.parent, { x: 30, y: 120, scale: 2 })
	assert.deepEqual(state.transform.effective, { x: 42, y: -9, scale: 1 })
	assert.notDeepEqual(state.transform.effective, state.transform.local)
})

test('single-layer WM transform remains backward-compatible', () => {
	const wm = createWMCore({ rootLayerId: 'screen' })
	wm.defineLayer('panel', {
		parent: 'screen',
		policy: { x: 'pan', y: 'pan', zoom: 'inherit' },
		transform: { x: 3, y: 4, scale: 2 },
		camera: { x: 5, y: 6, z: 7 },
	})

	assert.deepEqual(wm.transform('panel'), { x: 8, y: 10, scale: 14 })
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

test('FleetHUD pill drop translates overlay page point to document page through WM', () => {
	const calls: Array<[string, { x: number; y: number }]> = []
	const overlayEditor: FleetHudProjectionEditor = {
		pageToScreen(point: { x: number; y: number }) {
			calls.push(['overlay.pageToScreen', point])
			return { x: point.x + 75, y: point.y + 20 }
		},
		screenToPage(point: { x: number; y: number }) {
			calls.push(['overlay.screenToPage', point])
			return { x: point.x - 75, y: point.y - 20 }
		},
	}
	const documentEditor: FleetHudProjectionEditor = {
		pageToScreen(point: { x: number; y: number }) {
			calls.push(['document.pageToScreen', point])
			return { x: point.x + 400, y: point.y + 120 }
		},
		screenToPage(point: { x: number; y: number }) {
			calls.push(['document.screenToPage', point])
			return { x: point.x - 400, y: point.y - 120 }
		},
	}

	assert.deepEqual(
		translateFleetHudDropPoint(overlayEditor, documentEditor, { x: 120, y: 240 }),
		{ x: -205, y: 140 },
	)
	assert.deepEqual(calls, [
		['overlay.pageToScreen', { x: 120, y: 240 }],
		['document.screenToPage', { x: 195, y: 260 }],
	])
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
	assert.deepEqual(state.wm.transform(state.layerId), { x: -10, y: 60, scale: 0.5 })
	assert.deepEqual(state.layer.transform, { x: -10, y: 60, scale: 0.5 })
	assert.deepEqual(state.layer.camera, { x: 0, y: 0, z: 1 })
	assert.deepEqual(state.layer.policy, { x: 'pin', y: 'pin', zoom: 'lock' })
	assert.deepEqual(state.owner, { userId: 'fleet:tester', deviceId: 'mini' })
	assert.equal(state.source, null)
	assert.deepEqual(state.membership, {
		layerId: 'fleet-docview:docview-a',
		userId: 'fleet:tester',
		deviceId: 'mini',
	})
	assert.equal(state.hitPolicy, 'chrome-catches-content-pans')
})
