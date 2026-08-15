import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EDITOR_WM_ROOT_LAYER_ID,
  registerViewportLayer,
  unregisterViewportLayer,
  getRegisteredViewportLayer,
  getEditorWMCore,
  getEditorLayerModel,
  ensureLayer,
  bindEditorLayerModel,
  viewportCoordinateLayerId,
  viewportFrameLayerId,
} from '../src/wm/editor-wm.ts'
import { clientPointToPage } from '../src/wm/viewport-coordinates.ts'

test('clientPointToPage uses registered WM viewport coordinates before tldraw fallback', () => {
  const viewportId = 'hud:test'
  const editor = {
    screenToPage: () => ({ x: -1, y: -1 }),
  }
  const wm = getEditorWMCore(editor)
  const frameLayerId = viewportFrameLayerId(viewportId)
  const coordinateLayerId = viewportCoordinateLayerId(viewportId)
  wm.defineLayer(frameLayerId, {
    parent: EDITOR_WM_ROOT_LAYER_ID,
    transform: { x: 100, y: 50, scale: 1 },
  })
  wm.defineLayer(coordinateLayerId, {
    parent: frameLayerId,
    transform: { x: 10, y: 5, scale: 2 },
  })
  const registration = {
    viewportId,
    wm,
    frameLayerId,
    coordinateLayerId,
  }

  registerViewportLayer(editor, registration)
  try {
    assert.deepEqual(clientPointToPage(editor, { x: 130, y: 75 }, viewportId), { x: 10, y: 10 })
  } finally {
    unregisterViewportLayer(editor, viewportId, registration)
  }
})

test('viewport registrations belong to one editor even when ids match', () => {
  const viewportId = 'hud:shared-name'
  const editorA = { screenToPage: () => ({ x: -1, y: -1 }) }
  const editorB = { screenToPage: () => ({ x: -2, y: -2 }) }
  const wm = getEditorWMCore(editorA)
  const frameLayerId = viewportFrameLayerId(viewportId)
  const coordinateLayerId = viewportCoordinateLayerId(viewportId)
  wm.defineLayer(frameLayerId, { parent: EDITOR_WM_ROOT_LAYER_ID })
  wm.defineLayer(coordinateLayerId, { parent: frameLayerId })
  const registration = { viewportId, wm, frameLayerId, coordinateLayerId }

  registerViewportLayer(editorA, registration)
  try {
    assert.equal(getRegisteredViewportLayer(editorA, viewportId), registration)
    assert.equal(getRegisteredViewportLayer(editorB, viewportId), undefined)
  } finally {
    unregisterViewportLayer(editorA, viewportId, registration)
  }
})

test('an editor rejects a viewport registration backed by another editor core', () => {
  const viewportId = 'hud:foreign-core'
  const editorA = { screenToPage: () => ({ x: -1, y: -1 }) }
  const editorB = { screenToPage: () => ({ x: -2, y: -2 }) }
  const foreignCore = getEditorWMCore(editorA)
  const frameLayerId = viewportFrameLayerId(viewportId)
  const coordinateLayerId = viewportCoordinateLayerId(viewportId)
  const registration = { viewportId, wm: foreignCore, frameLayerId, coordinateLayerId }

  assert.throws(
    () => registerViewportLayer(editorB, registration),
    /must be registered with its editor's WM core/,
  )
})

test('editors over one project store share layer semantics but keep cameras local', () => {
  const store = {}
  const editorA = { store, screenToPage: point => point }
  const editorB = { store, screenToPage: point => point }
  const wmA = getEditorWMCore(editorA)
  const wmB = getEditorWMCore(editorB)

  ensureLayer(wmA, 'teacher-layer', {
    policy: { x: 'pin', y: 'pan', zoom: 'lock' },
    camera: { x: 10, y: 20, z: 2 },
  })

  assert.deepEqual(getEditorLayerModel(editorA).serialize(), getEditorLayerModel(editorB).serialize())
  assert.deepEqual(wmB.getLayer('teacher-layer').policy, { x: 'pin', y: 'pan', zoom: 'lock' })
  wmB.setCamera('teacher-layer', { x: -3, y: -4, z: 1 })
  assert.deepEqual(wmA.camera('teacher-layer'), { x: 10, y: 20, z: 2 })
  assert.deepEqual(wmB.camera('teacher-layer'), { x: -3, y: -4, z: 1 })
  const revision = getEditorLayerModel(editorA).serialize().revision
  ensureLayer(wmA, 'teacher-layer', { policy: { x: 'pin', y: 'pan', zoom: 'lock' } })
  assert.equal(getEditorLayerModel(editorA).serialize().revision, revision)
})

test('separate client stores reconcile one serialized project model while views stay local', async () => {
  const { createLayerModel } = await import('../packages/tldraw-wm/src/layer-model.ts')
  const modelA = createLayerModel({ rootLayerId: EDITOR_WM_ROOT_LAYER_ID, layers: [] })
  const modelB = createLayerModel(modelA.serialize())
  const editorA = { store: {}, screenToPage: point => point }
  const editorB = { store: {}, screenToPage: point => point }
  bindEditorLayerModel(editorA, modelA)
  bindEditorLayerModel(editorB, modelB)
  const wmA = getEditorWMCore(editorA)
  const wmB = getEditorWMCore(editorB)

  ensureLayer(wmA, 'student-layer', { policy: { x: 'pan', y: 'pin', zoom: 'inherit' } })
  modelB.reconcile(modelA.serialize())

  assert.deepEqual(wmB.getLayer('student-layer').policy, { x: 'pan', y: 'pin', zoom: 'inherit' })
  wmA.setCamera('student-layer', { x: 1, y: 2, z: 3 })
  wmB.setCamera('student-layer', { x: 4, y: 5, z: 6 })
  assert.notDeepEqual(wmA.camera('student-layer'), wmB.camera('student-layer'))

  modelA.remove('student-layer')
  modelB.reconcile(modelA.serialize())
  assert.equal(wmB.hasLayer('student-layer'), false)

  modelB.defineOrUpdate({ id: 'newer-layer' })
  const current = modelB.serialize()
  modelB.reconcile({ ...current, revision: current.revision - 1, layers: [] })
  assert.deepEqual(modelB.serialize().layers, current.layers)
})

test('a host can hydrate an empty editor view and stale remount data cannot replace configured semantics', async () => {
  const { createLayerModel } = await import('../packages/tldraw-wm/src/layer-model.ts')
  const editor = { store: {}, screenToPage: point => point }
  getEditorWMCore(editor)
  const hydrated = createLayerModel({
    rootLayerId: EDITOR_WM_ROOT_LAYER_ID,
    revision: 3,
    layers: [{
      id: 'hydrated-layer',
      parent: EDITOR_WM_ROOT_LAYER_ID,
      policy: { x: 'pan', y: 'pin', zoom: 'inherit' },
      cameraPanUnit: 'layer',
    }],
  })
  bindEditorLayerModel(editor, hydrated)
  assert.equal(getEditorWMCore(editor).hasLayer('hydrated-layer'), true)
  const rebound = bindEditorLayerModel(editor, createLayerModel({ rootLayerId: EDITOR_WM_ROOT_LAYER_ID, layers: [] }))
  assert.equal(rebound, hydrated)
  assert.equal(getEditorWMCore(editor).hasLayer('hydrated-layer'), true)
})

test('concurrent equal-revision layer edits converge by writer identity without changing local cameras', async () => {
  const { createLayerModel } = await import('../packages/tldraw-wm/src/layer-model.ts')
  const base = { version: 1, rootLayerId: EDITOR_WM_ROOT_LAYER_ID, revision: 0, writerId: '', layers: [] }
  const modelA = createLayerModel(base, { actorId: 'client-a' })
  const modelB = createLayerModel(base, { actorId: 'client-b' })
  const editorA = { store: {}, screenToPage: point => point }
  const editorB = { store: {}, screenToPage: point => point }
  bindEditorLayerModel(editorA, modelA)
  bindEditorLayerModel(editorB, modelB)
  const wmA = getEditorWMCore(editorA)
  const wmB = getEditorWMCore(editorB)

  ensureLayer(wmA, 'client-layer', { policy: { x: 'pin', y: 'pan', zoom: 'inherit' } })
  ensureLayer(wmB, 'client-layer', { policy: { x: 'pan', y: 'pin', zoom: 'inherit' } })
  wmA.setCamera('client-layer', { x: 1, y: 2, z: 3 })
  wmB.setCamera('client-layer', { x: 4, y: 5, z: 6 })
  const snapshotA = modelA.serialize()
  const snapshotB = modelB.serialize()
  modelA.reconcile(snapshotB)
  modelB.reconcile(snapshotA)

  assert.deepEqual(modelA.serialize(), modelB.serialize())
  assert.deepEqual(modelA.serialize(), snapshotB)
  assert.deepEqual(wmA.camera('client-layer'), { x: 1, y: 2, z: 3 })
  assert.deepEqual(wmB.camera('client-layer'), { x: 4, y: 5, z: 6 })
})

test('the project-store adapter republishes only the deterministic concurrent winner', async () => {
  const { createLayerModel } = await import('../packages/tldraw-wm/src/layer-model.ts')
  const { reconcileProjectLayerSnapshot } = await import('../src/wm/project-layer-model.ts')
  const base = { version: 1, rootLayerId: EDITOR_WM_ROOT_LAYER_ID, revision: 0, writerId: '', layers: [] }
  const modelA = createLayerModel(base, { actorId: 'client-a' })
  const modelB = createLayerModel(base, { actorId: 'client-b' })
  modelA.defineOrUpdate({ id: 'shared', policy: { x: 'pin' } })
  modelB.defineOrUpdate({ id: 'shared', policy: { y: 'pin' } })
  const transportInitiallyChose = modelA.serialize()
  const winner = reconcileProjectLayerSnapshot(modelB, transportInitiallyChose)
  assert.deepEqual(winner, modelB.serialize())
  assert.equal(reconcileProjectLayerSnapshot(modelA, winner), null)
  assert.deepEqual(modelA.serialize(), modelB.serialize())
})
