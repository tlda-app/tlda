import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
	TLDA_HOST_BOUNDARY_MODULES,
	WM_EXTRACTION_MODULES,
	WM_PACKAGE_ENTRY_CANDIDATES,
	wmExtractionModulesByClassification,
	type WmExtractionClassification,
} from '../src/wm/tldraw-wm-extraction-boundary.ts'

const repoRoot = new URL('..', import.meta.url).pathname

test('WM extraction boundary manifest points at real unique modules', () => {
	const paths = WM_EXTRACTION_MODULES.map((module) => module.path)
	assert.equal(new Set(paths).size, paths.length)
	for (const path of paths) {
		assert.equal(existsSync(join(repoRoot, path)), true, path)
	}
})

test('WM extraction boundary separates package candidates from tlda host modules', () => {
	assert.deepEqual(WM_PACKAGE_ENTRY_CANDIDATES, [
		'src/wm/wm-core.ts',
		'src/wm/hosted-panel-registry.ts',
		'src/wm/managed-surfaces.ts',
		'src/wm/gesture-policy.ts',
		'src/wm/editor-wm.ts',
		'src/wm/viewport-coordinates.ts',
		'src/wm/canvas-clip-panel.ts',
		'src/wm/gesture-frame.ts',
	])

	assert(TLDA_HOST_BOUNDARY_MODULES.includes('src/shapes/fleet-panel-registry.ts'))
	assert(TLDA_HOST_BOUNDARY_MODULES.includes('src/wm/annotation-viewer-surface.ts'))
	assert(!TLDA_HOST_BOUNDARY_MODULES.includes('src/wm/wm-core.ts'))
})

test('WM extraction boundary classifications are queryable and explicit', () => {
	const classifications: WmExtractionClassification[] = [
		'wm-package-core',
		'wm-package-tldraw-adapter',
		'tlda-host-adapter',
		'tlda-app-surface',
	]

	for (const classification of classifications) {
		const modules = wmExtractionModulesByClassification(classification)
		assert(modules.length > 0, classification)
		assert(modules.every((module) => module.classification === classification))
	}
})
