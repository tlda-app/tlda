import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	clientPointToPage,
	pagePointToClient,
	pagePointToPage,
} from '../src/wm/viewport-coordinates.ts'
import {
	EDITOR_WM_ROOT_LAYER_ID,
	cameraToCoordinateTransform,
	ensureLayer,
	getEditorWMCore,
	getEditorWMState,
	registerViewportLayer,
	viewportCoordinateLayerId,
	viewportFrameLayerId,
} from '../src/wm/editor-wm.ts'
import type { Editor, TLViewportId } from 'tldraw'

const HUD = 'hud' as TLViewportId

function makeEditor() {
	return {
		screenToPage(point: { x: number; y: number }, opts?: { viewportId?: string }) {
			if (opts?.viewportId === 'hud') {
				return { x: (point.x - 100) / 2 - 10, y: (point.y - 200) / 2 - 20 }
			}
			return { x: point.x - 5, y: point.y - 7 }
		},
		pageToScreen(point: { x: number; y: number }, opts?: { viewportId?: string }) {
			if (opts?.viewportId === 'hud') {
				return { x: (point.x + 10) * 2 + 100, y: (point.y + 20) * 2 + 200 }
			}
			return { x: point.x + 5, y: point.y + 7 }
		},
		getViewport(id: string) {
			assert.equal(id, 'hud')
			return { camera: { x: 10, y: 20, z: 2 } }
		},
		updateViewport() {},
	} as unknown as Editor
}

function registerHudViewport(editor: Editor) {
	const wm = getEditorWMCore(editor)
	const frameLayerId = viewportFrameLayerId(HUD)
	const coordinateLayerId = viewportCoordinateLayerId(HUD)
	ensureLayer(wm, frameLayerId, {
		parent: EDITOR_WM_ROOT_LAYER_ID,
		policy: { x: 'pin', y: 'pin', zoom: 'lock' },
		transform: { x: 100, y: 200, scale: 1 },
	})
	ensureLayer(wm, coordinateLayerId, {
		parent: frameLayerId,
		policy: { x: 'pin', y: 'pin', zoom: 'lock' },
		transform: cameraToCoordinateTransform({ x: 10, y: 20, z: 2 }),
	})
	registerViewportLayer(editor, { viewportId: HUD, wm, frameLayerId, coordinateLayerId })
	return { wm, frameLayerId, coordinateLayerId }
}

test('clientPointToPage uses the registered WM viewport layer when supplied', () => {
	const editor = makeEditor()
	registerHudViewport(editor)

	assert.deepEqual(clientPointToPage(editor, { x: 130, y: 250 }, HUD), {
		x: 5,
		y: 5,
	})
	assert.equal(getEditorWMState(editor).coordinateTraces.at(-1)?.path, 'wm')
	assert.deepEqual(clientPointToPage(editor, { x: 130, y: 250 }), {
		x: 125,
		y: 243,
	})
})

test('pagePointToClient is inverse for a viewport-backed layer', () => {
	const editor = makeEditor()
	registerHudViewport(editor)
	const client = { x: 180, y: 280 }
	const page = clientPointToPage(editor, client, HUD)

	assert.deepEqual(pagePointToClient(editor, page, HUD), client)
	assert.equal(getEditorWMState(editor).coordinateTraces.at(-1)?.path, 'wm')
})

test('pagePointToPage crosses through client space between layers', () => {
	const editor = makeEditor()
	registerHudViewport(editor)

	assert.deepEqual(pagePointToPage(editor, { x: 5, y: 5 }, HUD), {
		x: 125,
		y: 243,
	})
})

test('registered coordinate path changes when a WM layer changes', () => {
	const editor = makeEditor()
	const { wm, frameLayerId, coordinateLayerId } = registerHudViewport(editor)

	const before = clientPointToPage(editor, { x: 130, y: 250 }, HUD)
	wm.setTransform(frameLayerId, { x: 120, y: 200, scale: 1 })
	const afterFrameMove = clientPointToPage(editor, { x: 130, y: 250 }, HUD)
	wm.setTransform(frameLayerId, { x: 100, y: 200, scale: 1 })
	wm.setTransform(coordinateLayerId, cameraToCoordinateTransform({ x: 30, y: 20, z: 2 }))
	const afterCameraMove = clientPointToPage(editor, { x: 130, y: 250 }, HUD)

	assert.deepEqual(before, { x: 5, y: 5 })
	assert.notDeepEqual(afterFrameMove, before)
	assert.notDeepEqual(afterCameraMove, before)
})
