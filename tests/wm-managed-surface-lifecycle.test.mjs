import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ManagedSurfaceLifecycle,
  managedSurfaceEventOwner,
} from '../packages/tldraw-wm/src/managed-surfaces.ts'
import { createWMCore } from '../packages/tldraw-wm/src/wm-core.ts'
import {
  dismissManagedSurface,
  getManagedSurfacePolicy,
  registerManagedSurfaceCore,
  requestManagedSurface,
} from '../src/wm/managed-surfaces.ts'

function request(overrides = {}) {
  return {
    kind: 'panel',
    surfaceId: 'panel:a',
    layerId: 'panel-layer:a',
    owner: { principal: 'alice' },
    extent: { x: 0, y: 0, w: 100, h: 80 },
    placement: { mode: 'page' },
    cameraPolicy: { x: 'pan', y: 'pan', zoom: 'inherit' },
    hitPolicy: 'chrome-catches-content-pans',
    cleanup: { onClose: 'hide-surface', onReplace: 'replace-existing-surface', onOwnerChange: 'remove-surface' },
    persistence: { pinned: false, scope: 'local' },
    source: null,
    payload: {},
    ...overrides,
  }
}

test('managed-surface lifecycle enforces replacement, ownership, and close policy', () => {
  const events = []
  const lifecycle = new ManagedSurfaceLifecycle({
    sameOwner: (a, b) => a.principal === b.principal,
    show: surface => events.push(['show', surface.surfaceId]),
    remove: surface => events.push(['remove', surface.surfaceId]),
    hide: surface => events.push(['hide', surface.surfaceId]),
    preserve: surface => events.push(['preserve', surface.surfaceId]),
    applyPlacement: surface => events.push(['placement', surface.surfaceId]),
    applyCameraPolicy: surface => events.push(['camera', surface.surfaceId]),
    applyHitPolicy: surface => events.push(['hit', surface.surfaceId]),
    persist: surface => events.push(['persist', surface.surfaceId]),
    clearPersistence: surface => events.push(['clear', surface.surfaceId]),
  })

  lifecycle.request(request())
  lifecycle.request(request({ surfaceId: 'panel:b' }))
  assert.deepEqual(events, [
    ['placement', 'panel:a'], ['camera', 'panel:a'], ['hit', 'panel:a'], ['show', 'panel:a'],
    ['placement', 'panel:b'], ['camera', 'panel:b'], ['hit', 'panel:b'], ['show', 'panel:b'],
  ])

  lifecycle.request(request({ surfaceId: 'panel:b', owner: { principal: 'bob' }, persistence: { pinned: true, scope: 'local' } }))
  assert.deepEqual(events.slice(-6), [
    ['remove', 'panel:b'], ['placement', 'panel:b'], ['camera', 'panel:b'], ['hit', 'panel:b'], ['show', 'panel:b'], ['persist', 'panel:b'],
  ])
  assert.equal(lifecycle.hitPolicy('panel:b'), 'chrome-catches-content-pans')
  assert.equal(lifecycle.closeKind('panel'), true)
  assert.deepEqual(events.slice(-3), [['hide', 'panel:a'], ['hide', 'panel:b'], ['clear', 'panel:b']])
})

test('tlda host applies policy state and session persistence instead of emitting dead policy events', () => {
  const target = new EventTarget()
  const wm = createWMCore({ rootLayerId: 'screen' })
  registerManagedSurfaceCore(target, wm)
  const persisted = new Map()
  Object.defineProperty(target, 'sessionStorage', { value: {
    setItem: (key, value) => persisted.set(key, value),
    removeItem: key => persisted.delete(key),
  } })
  const surface = request({
    surfaceId: 'panel:host',
    owner: { userId: 'fleet:test', deviceId: 'device:test' },
    persistence: { pinned: true, scope: 'session' },
  })
  const active = requestManagedSurface(target, surface)
  assert.equal(getManagedSurfacePolicy(target, active.surfaceId)?.hitPolicy, 'chrome-catches-content-pans')
  assert.deepEqual(wm.getLayer(active.layerId)?.policy, active.cameraPolicy)
  assert.equal(persisted.has('tlda-managed-surface:panel:host'), true)
  assert.equal(dismissManagedSurface(target, 'panel'), true)
  assert.equal(getManagedSurfacePolicy(target, active.surfaceId), undefined)
  assert.equal(wm.hasLayer(active.layerId), false)
  assert.equal(persisted.has('tlda-managed-surface:panel:host'), false)

  assert.throws(() => requestManagedSurface(target, request({
    surfaceId: 'panel:bad-placement',
    owner: { userId: 'fleet:test', deviceId: 'device:test' },
    extent: { x: 10, y: 0, w: 100, h: 80 },
    placement: { mode: 'page', left: 0, top: 0 },
  })), /placement does not match its extent/)
})

test('managed hit policy resolves content, chrome, and modal ownership', () => {
  assert.equal(managedSurfaceEventOwner('preview-readonly', 'content'), 'surface')
  assert.equal(managedSurfaceEventOwner('chrome-catches-content-pans', 'content'), 'content')
  assert.equal(managedSurfaceEventOwner('chrome-catches-content-pans', 'chrome'), 'surface')
  assert.equal(managedSurfaceEventOwner('chrome-catches-content-pans', 'outside'), 'underlay')
  assert.equal(managedSurfaceEventOwner('modal-catches-all', 'outside'), 'surface')
})
