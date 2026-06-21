import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeFleetBoundsFromShapes, createFleetBoundsTracker, type PageBounds } from '../src/overlays/fleet-bounds.ts'

type TestShape = {
  id: string
  typeName: 'shape'
  type: string
  props: {
    userId?: string
    deviceId?: string
  }
}

type ShapeChanges = {
  added: Record<string, TestShape>
  removed: Record<string, TestShape>
  updated: Record<string, [TestShape, TestShape]>
}

const OWN_USER = 'fleet:skip'
const OWN_DEVICE = 'mac'

function shape(id: string, type: string, userId?: string, deviceId?: string): TestShape {
  return { id, typeName: 'shape', type, props: { userId, deviceId } }
}

function isMine(s: TestShape): boolean {
  const fleetTypes = new Set(['fleet-chat', 'fleet-agents', 'fleet-inbox'])
  return fleetTypes.has(s.type) && s.props.userId === OWN_USER && s.props.deviceId === OWN_DEVICE
}

function bounds(x: number, y: number, w = 10, h = 10): PageBounds {
  return { x, y, w, h }
}

function emptyChanges(): ShapeChanges {
  return { added: {}, removed: {}, updated: {} }
}

test('delta-maintained fleet bounds match full-sweep bounds without rescanning page shapes per change', () => {
  const shapes = new Map<string, TestShape>()
  const shapeBounds = new Map<string, PageBounds>()
  let fullPageSweeps = 0

  const allShapes = () => {
    fullPageSweeps += 1
    return [...shapes.values()]
  }
  const fullSweep = () => computeFleetBoundsFromShapes(allShapes().filter(isMine), id => shapeBounds.get(id))
  const tracker = createFleetBoundsTracker<TestShape>({
    isFleetShape: isMine,
    getShapePageBounds: id => shapeBounds.get(id),
  })

  const applyAdd = (s: TestShape, b: PageBounds) => {
    shapes.set(s.id, s)
    shapeBounds.set(s.id, b)
    const changes = emptyChanges()
    changes.added[s.id] = s
    return changes
  }
  const applyUpdate = (id: string, next: TestShape, b: PageBounds) => {
    const prev = shapes.get(id)
    assert.ok(prev)
    shapes.set(id, next)
    shapeBounds.set(id, b)
    const changes = emptyChanges()
    changes.updated[id] = [prev, next]
    return changes
  }
  const applyRemove = (id: string) => {
    const prev = shapes.get(id)
    assert.ok(prev)
    shapes.delete(id)
    shapeBounds.delete(id)
    const changes = emptyChanges()
    changes.removed[id] = prev
    return changes
  }

  tracker.reset(allShapes())
  assert.equal(fullPageSweeps, 1)

  const stream: Array<() => ShapeChanges> = [
    () => applyAdd(shape('doc-1', 'svg-page'), bounds(0, 0, 600, 800)),
    () => applyAdd(shape('mine-chat', 'fleet-chat', OWN_USER, OWN_DEVICE), bounds(100, 100, 40, 80)),
    () => applyAdd(shape('foreign-chat', 'fleet-chat', 'fleet:other', OWN_DEVICE), bounds(-1000, -1000, 500, 500)),
    () => applyAdd(shape('mine-agents', 'fleet-agents', OWN_USER, OWN_DEVICE), bounds(200, 120, 50, 60)),
    () => applyUpdate('mine-chat', shape('mine-chat', 'fleet-chat', OWN_USER, OWN_DEVICE), bounds(80, 90, 45, 85)),
    () => applyUpdate('foreign-chat', shape('foreign-chat', 'fleet-chat', OWN_USER, OWN_DEVICE), bounds(10, 20, 20, 20)),
    () => applyUpdate('mine-agents', shape('mine-agents', 'fleet-agents', OWN_USER, 'ipad'), bounds(200, 120, 50, 60)),
    () => applyAdd(shape('mine-inbox', 'fleet-inbox', OWN_USER, OWN_DEVICE), bounds(-20, 40, 30, 30)),
    () => applyRemove('mine-chat'),
    () => applyRemove('doc-1'),
    () => applyUpdate('foreign-chat', shape('foreign-chat', 'fleet-chat', 'fleet:other', OWN_DEVICE), bounds(10, 20, 20, 20)),
    () => applyRemove('mine-inbox'),
  ]

  for (const makeChanges of stream) {
    const changes = makeChanges()
    const sweepsBefore = fullPageSweeps
    const maintained = tracker.applyChanges(changes)?.bounds ?? tracker.getResult().bounds
    assert.equal(fullPageSweeps, sweepsBefore)
    assert.deepEqual(maintained, fullSweep().bounds)
  }
})
