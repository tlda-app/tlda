import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	clientPointToPage,
	pagePointToClient,
	pagePointToPage,
} from '../src/wm/viewport-coordinates.ts'
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

test('clientPointToPage uses the registered viewport layer when supplied', () => {
	const editor = makeEditor()

	assert.deepEqual(clientPointToPage(editor, { x: 130, y: 250 }, HUD), {
		x: 5,
		y: 5,
	})
	assert.deepEqual(clientPointToPage(editor, { x: 130, y: 250 }), {
		x: 125,
		y: 243,
	})
})

test('pagePointToClient is inverse for a viewport-backed layer', () => {
	const editor = makeEditor()
	const client = { x: 180, y: 280 }
	const page = clientPointToPage(editor, client, HUD)

	assert.deepEqual(pagePointToClient(editor, page, HUD), client)
})

test('pagePointToPage crosses through client space between layers', () => {
	const editor = makeEditor()

	assert.deepEqual(pagePointToPage(editor, { x: 5, y: 5 }, HUD), {
		x: 125,
		y: 243,
	})
})
