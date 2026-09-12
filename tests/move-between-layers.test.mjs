import test from 'node:test'
import assert from 'node:assert/strict'
import { moveShapesToLayer, copyShapesToLayer, shapeForDestination, layerFrameConversion, sameFrame, LayerMoveFailed, LayerCopyFailed } from '../src/classroom/moveBetweenLayers.ts'

// Layers are separate sync rooms, so moving an annotation crosses stores. The
// failure worth testing is not "does tldraw create a shape" — it is the
// ORDERING, because a move that half-happens is a duplicate or a loss and
// neither announces itself.
//
// These fakes stand in for the two rooms. That is deliberate: the thing under
// test is create -> verify -> delete and what happens when the middle step
// fails, which no real store can be made to do on demand.

function room({ shapes = [], rejectCreate = false, pageId = 'page:dest' } = {}) {
  const byId = new Map(shapes.map(s => [s.id, s]))
  const log = []
  return {
    log,
    byId,
    getShape: id => byId.get(id),
    createShapes: incoming => {
      log.push('create')
      if (rejectCreate) return // a store that drops records without complaining
      for (const s of incoming) byId.set(s.id, s)
    },
    deleteShapes: ids => {
      log.push('delete')
      for (const id of ids) byId.delete(id)
    },
    getCurrentPageId: () => pageId,
    isLive: () => true,
  }
}

const mark = (id, over) => ({ id, type: 'draw', x: 10, y: 20, parentId: 'page:source', index: 'a1', props: { color: 'red' }, ...over })

test('an annotation moves: it is in the destination and gone from the source', () => {
  const source = room({ shapes: [mark('shape:one')] })
  const destination = room()

  const moved = moveShapesToLayer(source, destination, ['shape:one'], sameFrame)

  assert.deepEqual(moved, ['shape:one'])
  assert.ok(destination.getShape('shape:one'), 'the annotation did not arrive')
  assert.equal(source.getShape('shape:one'), undefined, 'the annotation is still on the old layer — a copy, not a move')
})

test('it is created before it is deleted, so a crash between them cannot lose it', () => {
  const source = room({ shapes: [mark('shape:one')] })
  const destination = room()

  moveShapesToLayer(source, destination, ['shape:one'], sameFrame)

  assert.deepEqual(destination.log, ['create'])
  assert.deepEqual(source.log, ['delete'])
  // The whole guarantee in one line: the write happened first.
  assert.ok(
    destination.log.indexOf('create') === 0 && source.log.indexOf('delete') === 0,
    'ordering changed; a failure between the two steps would now lose the annotation',
  )
})

test('a destination that silently drops the record loses nothing', () => {
  const source = room({ shapes: [mark('shape:one')] })
  const destination = room({ rejectCreate: true })

  assert.throws(() => moveShapesToLayer(source, destination, ['shape:one'], sameFrame), LayerMoveFailed)

  // This is the case the ordering exists for.
  assert.ok(source.getShape('shape:one'), 'the annotation was deleted after the destination refused it')
  assert.deepEqual(source.log, [], 'the source was written to despite the failure')
})

test('identity and position survive the move', () => {
  const out = shapeForDestination(mark('shape:one'), 'page:dest', sameFrame)

  assert.equal(out.id, 'shape:one', 'a new id makes it a lookalike rather than the same annotation')
  assert.equal(out.x, 10)
  assert.equal(out.y, 20)
  assert.deepEqual(out.props, { color: 'red' })
})

test('a page-parented shape is re-parented; one nested in a moving shape is not', () => {
  const top = shapeForDestination(mark('shape:one', { parentId: 'page:source' }), 'page:dest', sameFrame)
  assert.equal(top.parentId, 'page:dest', 'kept a parent that does not exist in the destination')

  const nested = shapeForDestination(mark('shape:two', { parentId: 'shape:one' }), 'page:dest', sameFrame)
  assert.equal(nested.parentId, 'shape:one', 'a child was torn off the parent moving with it')
})

test("the source room's ordering index is not carried across", () => {
  const out = shapeForDestination(mark('shape:one'), 'page:dest', sameFrame)
  assert.equal(out.index, undefined, 'a fractional index from another room means nothing here and can collide')
})

test('moving nothing does nothing', () => {
  const source = room({ shapes: [mark('shape:one')] })
  const destination = room()

  assert.deepEqual(moveShapesToLayer(source, destination, [], sameFrame), [])
  assert.deepEqual(destination.log, [], 'an empty move still wrote to the destination')
  assert.deepEqual(source.log, [], 'an empty move still deleted from the source')
})

// --- copy ---
//
// Skip named two operations: "we can expose, like, move and copy." A copy leaves
// the original, so the loss risk of a move is absent — but it introduces one a
// move does not have. A move carries the id across because it is the same
// annotation on another layer; a copy makes a SECOND annotation, and giving both
// the same id is a collision waiting for either to be moved into the other's
// room.

test('a copy lands on the destination and the original stays put', () => {
  const source = room({ shapes: [mark('shape:one')], pageId: 'page:source' })
  const destination = room({ pageId: 'page:dest' })
  let n = 0
  const copied = copyShapesToLayer(source, destination, ['shape:one'], () => `shape:copy${++n}`, sameFrame)

  assert.deepEqual(copied, ['shape:copy1'])
  assert.ok(destination.getShape('shape:copy1'), 'the copy is on the destination')
  assert.ok(source.getShape('shape:one'), 'the original is untouched')
  assert.ok(!destination.log.includes('delete'), 'a copy deletes nothing')
  assert.ok(!source.log.includes('delete'), 'least of all from the source')
})

test('a copy gets a new id, so it cannot collide with the shape it came from', () => {
  const source = room({ shapes: [mark('shape:one')] })
  const destination = room()
  const [copied] = copyShapesToLayer(source, destination, ['shape:one'], () => 'shape:fresh', sameFrame)
  assert.equal(copied, 'shape:fresh')
  assert.equal(destination.getShape('shape:one'), undefined, 'the source id is not reused')
})

test('position and props survive a copy; the ordering index does not', () => {
  const source = room({ shapes: [mark('shape:one', { x: 12, y: 34 })] })
  const destination = room()
  copyShapesToLayer(source, destination, ['shape:one'], () => 'shape:fresh', sameFrame)
  const copy = destination.getShape('shape:fresh')
  assert.equal(copy.x, 12)
  assert.equal(copy.y, 34)
  assert.deepEqual(copy.props, { color: 'red' })
  assert.equal(copy.index, undefined, "the source room's index means nothing here")
})

test('a shape nested in another copied shape points at that shape’s copy', () => {
  const parent = mark('shape:parent')
  const child = mark('shape:child', { parentId: 'shape:parent' })
  const source = room({ shapes: [parent, child] })
  const destination = room({ pageId: 'page:dest' })
  const order = ['shape:p2', 'shape:c2']
  let i = 0
  copyShapesToLayer(source, destination, ['shape:parent', 'shape:child'], () => order[i++], sameFrame)

  assert.equal(destination.getShape('shape:c2').parentId, 'shape:p2',
    'the copy is nested in the copy, not in the original it came from')
})

test('a shape nested in something left behind joins the destination page', () => {
  const child = mark('shape:child', { parentId: 'shape:staying' })
  const source = room({ shapes: [child] })
  const destination = room({ pageId: 'page:dest' })
  copyShapesToLayer(source, destination, ['shape:child'], () => 'shape:c2', sameFrame)
  assert.equal(destination.getShape('shape:c2').parentId, 'page:dest',
    'no dangling parent pointing into the room it came from')
})

test('a destination that silently drops the record reports it, and changes nothing', () => {
  const source = room({ shapes: [mark('shape:one')] })
  const destination = room({ rejectCreate: true })
  assert.throws(() => copyShapesToLayer(source, destination, ['shape:one'], () => 'shape:fresh', sameFrame), LayerCopyFailed)
  assert.ok(source.getShape('shape:one'), 'the original is still there')
})

test('copying nothing does nothing', () => {
  const source = room()
  const destination = room()
  assert.deepEqual(copyShapesToLayer(source, destination, [], () => 'shape:x', sameFrame), [])
  assert.deepEqual(destination.log, [])
})
