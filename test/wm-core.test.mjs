import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'

const tempDir = mkdtempSync(join(tmpdir(), 'tlda-wm-core-test-'))
const source = readFileSync(new URL('../src/wm/wm-core.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
	compilerOptions: {
		module: ts.ModuleKind.ES2022,
		target: ts.ScriptTarget.ES2022,
		verbatimModuleSyntax: true,
		erasableSyntaxOnly: true,
	},
	fileName: 'wm-core.ts',
}).outputText
const modulePath = join(tempDir, 'wm-core.mjs')
writeFileSync(modulePath, compiled)

const { createLayerMembership, createLayerOwner, createWMCore } = await import(modulePath)

test.after(() => {
	rmSync(tempDir, { recursive: true, force: true })
})

test('composes root to child transforms and inverses them', () => {
	const wm = createWMCore()
	wm.defineLayer('content', {
		transform: { x: 10, y: 20, scale: 2 },
		policy: { x: 'pin', y: 'pin', zoom: 'lock' },
	})

	assert.deepEqual(wm.translate({ x: 1, y: 2 }, 'content', 'root'), { x: 12, y: 24 })
	assert.deepEqual(wm.translate({ x: 12, y: 24 }, 'root', 'content'), { x: 1, y: 2 })
})

test('applies pan, pin, and parametric track policies', () => {
	const wm = createWMCore()
	wm.defineLayer('pan', {
		camera: { x: 100, y: 50, z: 2 },
		policy: { x: 'pan', y: 'pan', zoom: 'inherit' },
	})
	wm.defineLayer('pin', {
		camera: { x: 100, y: 50, z: 2 },
		policy: { x: 'pin', y: 'pin', zoom: 'lock' },
	})
	wm.defineLayer('track', {
		camera: { x: 100, y: 50, z: 2 },
		policy: { x: { track: 0.25 }, y: { track: 0.5 }, zoom: 'own' },
	})

	assert.deepEqual(wm.translate({ x: 10, y: 10 }, 'pan', 'root'), { x: 120, y: 70 })
	assert.deepEqual(wm.translate({ x: 10, y: 10 }, 'pin', 'root'), { x: 10, y: 10 })
	assert.deepEqual(wm.translate({ x: 10, y: 10 }, 'track', 'root'), { x: 45, y: 45 })
})

test('bridges viewport-backed layers through the fork endpoint adapter', () => {
	const calls = []
	const editor = {
		pageToScreen(point, opts) {
			calls.push(['pageToScreen', opts.viewportId])
			return { x: point.x * 2 + 100, y: point.y * 2 + 200 }
		},
		screenToPage(point, opts) {
			calls.push(['screenToPage', opts.viewportId])
			return { x: (point.x - 100) / 2, y: (point.y - 200) / 2 }
		},
	}

	const wm = createWMCore()
	wm.defineLayer('doc-window', {
		backing: { kind: 'viewport', viewportId: 'vp-a', editor },
	})
	wm.defineLayer('hud', {
		transform: { x: 50, y: 75, scale: 1 },
		policy: { x: 'pin', y: 'pin', zoom: 'lock' },
	})

	assert.deepEqual(wm.translate({ x: 10, y: 20 }, 'doc-window', 'hud'), { x: 70, y: 165 })
	assert.deepEqual(wm.translate({ x: 70, y: 165 }, 'hud', 'doc-window'), { x: 10, y: 20 })
	assert.deepEqual(calls, [
		['pageToScreen', 'vp-a'],
		['screenToPage', 'vp-a'],
	])
})

test('bridges page-backed layers through document page coordinates', () => {
	const calls = []
	const editor = {
		pageToScreen(point) {
			calls.push(['pageToScreen', point])
			return { x: point.x + 300, y: point.y + 40 }
		},
		screenToPage(point) {
			calls.push(['screenToPage', point])
			return { x: point.x - 300, y: point.y - 40 }
		},
	}

	const wm = createWMCore()
	wm.defineLayer('document-page', {
		backing: { kind: 'page', editor },
	})
	wm.defineLayer('hud', {
		transform: { x: 20, y: 10, scale: 1 },
		policy: { x: 'pin', y: 'pin', zoom: 'lock' },
	})

	assert.deepEqual(wm.translate({ x: -100, y: 5 }, 'document-page', 'hud'), { x: 180, y: 35 })
	assert.deepEqual(wm.translate({ x: 180, y: 35 }, 'hud', 'document-page'), { x: -100, y: 5 })
	assert.deepEqual(calls, [
		['pageToScreen', { x: -100, y: 5 }],
		['screenToPage', { x: 200, y: 45 }],
	])
})

test('translates bounds with scale and offset', () => {
	const wm = createWMCore()
	wm.defineLayer('content', {
		transform: { x: 10, y: 20, scale: 2 },
		policy: { x: 'pin', y: 'pin', zoom: 'lock' },
	})

	assert.deepEqual(wm.translateBounds({ x: 1, y: 2, w: 3, h: 4 }, 'content', 'root'), {
		x: 12,
		y: 24,
		w: 6,
		h: 8,
	})
})

test('moves shapes between layers by re-expressing coordinates', () => {
	const wm = createWMCore()
	wm.defineLayer('content', {
		transform: { x: 10, y: 20, scale: 2 },
		policy: { x: 'pin', y: 'pin', zoom: 'lock' },
	})
	wm.defineLayer('overlay', {
		transform: { x: 100, y: 200, scale: 1 },
		policy: { x: 'pin', y: 'pin', zoom: 'lock' },
	})

	const moved = wm.moveToLayer({ id: 'shape:a', x: 1, y: 2, layerId: 'content', label: 'kept' }, 'overlay')

	assert.deepEqual(moved, { id: 'shape:a', x: -88, y: -176, layerId: 'overlay', label: 'kept' })
})

test('reads and writes viewport-backed layer cameras through the adapter when available', () => {
	let camera = { x: 1, y: 2, z: 3 }
	const wm = createWMCore()
	wm.defineLayer('doc-window', {
		backing: {
			kind: 'viewport',
			viewportId: 'vp-a',
			editor: {
				pageToScreen: (point) => point,
				screenToPage: (point) => point,
				getCamera: () => camera,
				setCamera: (_viewportId, nextCamera) => {
					camera = nextCamera
				},
			},
		},
	})

	assert.deepEqual(wm.camera('doc-window'), { x: 1, y: 2, z: 3 })
	wm.setCamera('doc-window', { x: 4, y: 5, z: 6 })
	assert.deepEqual(wm.camera('doc-window'), { x: 4, y: 5, z: 6 })
})

test('creates reusable owner and layer membership descriptors', () => {
	const owner = createLayerOwner('fleet:tester', 'mini')

	assert.deepEqual(owner, { userId: 'fleet:tester', deviceId: 'mini' })
	assert.deepEqual(createLayerMembership('fleet-overlay', owner), {
		layerId: 'fleet-overlay',
		userId: 'fleet:tester',
		deviceId: 'mini',
	})
})
