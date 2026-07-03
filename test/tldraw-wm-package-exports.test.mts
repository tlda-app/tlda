import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import * as packageCore from '../packages/tldraw-wm/src/core.ts'
import * as packageEntrypoint from '../packages/tldraw-wm/src/index.ts'
import * as tldrawAdapter from '../packages/tldraw-wm/src/tldraw-adapter.ts'
import {
	WM_PACKAGE_ENTRY_CANDIDATES,
	wmExtractionModulesByClassification,
} from '../src/wm/tldraw-wm-extraction-boundary.ts'

const packageJson = JSON.parse(readFileSync(new URL('../packages/tldraw-wm/package.json', import.meta.url), 'utf8'))

test('tldraw WM package declares core and adapter subpath exports', () => {
	assert.equal(packageJson.name, '@tlda/tldraw-wm')
	assert.deepEqual(packageJson.exports, {
		'.': './src/index.ts',
		'./core': './src/core.ts',
		'./tldraw-adapter': './src/tldraw-adapter.ts',
	})
	assert.deepEqual(packageJson.peerDependencies, { tldraw: '*' })
})

test('tldraw WM package core exports package-core modules', () => {
	assert.equal(typeof packageCore.createWMCore, 'function')
	assert.equal(typeof packageCore.defineHostedPanelApps, 'function')
	assert.equal(typeof packageCore.managedSurfaceShapeMeta, 'function')
	assert.equal(typeof packageCore.classifySoftGesture, 'function')
})

test('tldraw WM package tldraw adapter exports adapter modules', () => {
	assert.equal(typeof tldrawAdapter.getEditorWMCore, 'function')
	assert.equal(typeof tldrawAdapter.registerViewportLayer, 'function')
	assert.equal(typeof tldrawAdapter.clientPointToPage, 'function')
	assert.equal(typeof tldrawAdapter.createCanvasClipPanelPlan, 'function')
	assert.equal(typeof tldrawAdapter.getGestureViewportCamera, 'function')
})

test('tldraw WM package entrypoint exposes core and tldraw adapter surfaces', () => {
	assert.equal(packageEntrypoint.createWMCore, packageCore.createWMCore)
	assert.equal(packageEntrypoint.registerViewportLayer, tldrawAdapter.registerViewportLayer)
	assert.equal(packageEntrypoint.clientPointToPage, tldrawAdapter.clientPointToPage)
})

test('extraction manifest package candidates are reachable through package entrypoints', () => {
	assert.deepEqual(WM_PACKAGE_ENTRY_CANDIDATES, [
		...wmExtractionModulesByClassification('wm-package-core').map((module) => module.path),
		...wmExtractionModulesByClassification('wm-package-tldraw-adapter').map((module) => module.path),
	])
})
