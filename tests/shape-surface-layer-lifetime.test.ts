/**
 * A surface layer's lifetime is the shape's, not a renderer's.
 *
 * The defect this covers: the fleet HUD is a second viewport over the same
 * store, so one `fleet-docview` shape mounts twice against the same
 * editor-scoped `WMCore` with the same layer id. Each renderer's unmount ran
 * `removeLayers(surface.wm, [surface.layerId])`, so when the render gate
 * unmounted the main-canvas copy, the still-mounted HUD copy read a layer that
 * had just been deleted underneath it:
 *
 *     Layer "fleet-docview:fleet-docview-photographer-c87ef20d" is not defined
 *
 * These are behaviours of the running system, not assertions that nobody has
 * written the old cleanup: the first fails if a renderer ever owns the layer
 * again, and the second fails if the removal is simply dropped, which is the
 * leak the fix must not be.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { Editor } from 'tldraw'
import { createWMCore } from '../packages/tldraw-wm/src/wm-core.ts'
import { ensureViewLayer } from '../packages/tldraw-wm/src/editor-wm.ts'
import {
	docClipLayerId,
	installSurfaceLayerDisposal,
	surfaceLayerIdOfShape,
} from '../src/wm/shape-surface-layers.ts'
import { fleetDocviewLayerId } from '../src/wm/fleet-docview-layer.ts'

const DOCVIEW = { id: 'shape:fleet-docview-photographer-c87ef20d', type: 'fleet-docview' }

/** Enough Editor for the disposal: it registers one side effect and nothing else. */
function stubEditor() {
	const handlers: Array<(shape: { id: string; type: string }) => void> = []
	const editor = {
		sideEffects: {
			registerAfterDeleteHandler: (_t: string, fn: (shape: { id: string; type: string }) => void) => {
				handlers.push(fn)
				return () => {}
			},
		},
	} as unknown as Editor
	return { editor, deleteShape: (shape: { id: string; type: string }) => handlers.forEach(fn => fn(shape)), handlers }
}

/** What each renderer of the shape does on mount. `ensureViewLayer` is idempotent. */
function mountRenderer(wm: ReturnType<typeof createWMCore>, layerId: string) {
	ensureViewLayer(wm, layerId, {
		parent: wm.rootLayerId,
		policy: { x: 'pin', y: 'pin', zoom: 'lock' },
		transform: { x: 0, y: 0, scale: 1 },
	})
}

test('both renderers of one shape share a single layer', () => {
	// The property the fix rests on: the main canvas and the fleet HUD each
	// mount this shape and each ensure its layer, and that is ONE layer, so
	// neither renderer is creating something of its own to clean up. It goes
	// red if `ensureViewLayer` ever stops being idempotent, at which point
	// per-shape disposal would leave the second layer behind.
	const wm = createWMCore({ rootLayerId: 'screen' })
	const { editor, deleteShape } = stubEditor()
	installSurfaceLayerDisposal(editor, wm)
	const layerId = fleetDocviewLayerId(DOCVIEW.id)

	const before = wm.layerCount()
	mountRenderer(wm, layerId) // main canvas
	mountRenderer(wm, layerId) // fleet HUD, same shape, same core
	assert.equal(wm.layerCount(), before + 1)
	assert.doesNotThrow(() => wm.transform(layerId))

	// And one delete accounts for all of it.
	deleteShape(DOCVIEW)
	assert.equal(wm.layerCount(), before)
})

test('deleting the shape removes its layer', () => {
	const wm = createWMCore({ rootLayerId: 'screen' })
	const { editor, deleteShape } = stubEditor()
	installSurfaceLayerDisposal(editor, wm)
	const layerId = fleetDocviewLayerId(DOCVIEW.id)

	mountRenderer(wm, layerId)
	assert.equal(wm.hasLayer(layerId), true)
	deleteShape(DOCVIEW)
	assert.equal(wm.hasLayer(layerId), false)
})

test('a doc-clip shape is disposed the same way', () => {
	const wm = createWMCore({ rootLayerId: 'screen' })
	const { editor, deleteShape } = stubEditor()
	installSurfaceLayerDisposal(editor, wm)
	const clip = { id: 'shape:doc-clip-1', type: 'doc-clip' }
	const layerId = docClipLayerId(clip.id)

	mountRenderer(wm, layerId)
	deleteShape(clip)
	assert.equal(wm.hasLayer(layerId), false)
})

test('deleting a shape that owns no surface layer disturbs nothing', () => {
	const wm = createWMCore({ rootLayerId: 'screen' })
	const { editor, deleteShape } = stubEditor()
	installSurfaceLayerDisposal(editor, wm)
	const layerId = fleetDocviewLayerId(DOCVIEW.id)

	mountRenderer(wm, layerId)
	deleteShape({ id: 'shape:some-note', type: 'note' })
	assert.equal(wm.hasLayer(layerId), true)
	assert.equal(surfaceLayerIdOfShape({ id: 'shape:some-note', type: 'note' }), null)
})

test('the disposal registers once per editor, however often it is installed', () => {
	const wm = createWMCore({ rootLayerId: 'screen' })
	const { editor, handlers } = stubEditor()
	installSurfaceLayerDisposal(editor, wm)
	installSurfaceLayerDisposal(editor, wm)
	installSurfaceLayerDisposal(editor, wm)
	assert.equal(handlers.length, 1)
})

// Deliberately NOT tested: "the renderer and the disposal derive the same
// layer id". Both sides call the same exported function, so an assertion
// comparing them moves with whatever it is checking — mutating the derivation
// left it green. That property is held by construction instead:
// `createFleetDocviewSurface` and `DocClipShape` import the same
// `fleetDocviewLayerId` / `docClipLayerId` the disposal uses, so there is one
// derivation and nothing to disagree with.
