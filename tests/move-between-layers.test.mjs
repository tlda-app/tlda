import test from 'node:test'
import assert from 'node:assert/strict'
import { moveShapesToLayer, shapeForDestination, LayerMoveFailed } from '../src/classroom/moveBetweenLayers.ts'

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
  }
}

const mark = (id, over) => ({ id, type: 'draw', x: 10, y: 20, parentId: 'page:source', index: 'a1', props: { color: 'red' }, ...over })

test('an annotation moves: it is in the destination and gone from the source', () => {
  const source = room({ shapes: [mark('shape:one')] })
  const destination = room()

  const moved = moveShapesToLayer(source, destination, ['shape:one'])

  assert.deepEqual(moved, ['shape:one'])
  assert.ok(destination.getShape('shape:one'), 'the annotation did not arrive')
  assert.equal(source.getShape('shape:one'), undefined, 'the annotation is still on the old layer — a copy, not a move')
})

test('it is created before it is deleted, so a crash between them cannot lose it', () => {
  const source = room({ shapes: [mark('shape:one')] })
  const destination = room()

  moveShapesToLayer(source, destination, ['shape:one'])

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

  assert.throws(() => moveShapesToLayer(source, destination, ['shape:one']), LayerMoveFailed)

  // This is the case the ordering exists for.
  assert.ok(source.getShape('shape:one'), 'the annotation was deleted after the destination refused it')
  assert.deepEqual(source.log, [], 'the source was written to despite the failure')
})

test('identity and position survive the move', () => {
  const out = shapeForDestination(mark('shape:one'), 'page:dest')

  assert.equal(out.id, 'shape:one', 'a new id makes it a lookalike rather than the same annotation')
  assert.equal(out.x, 10)
  assert.equal(out.y, 20)
  assert.deepEqual(out.props, { color: 'red' })
})

test('a page-parented shape is re-parented; one nested in a moving shape is not', () => {
  const top = shapeForDestination(mark('shape:one', { parentId: 'page:source' }), 'page:dest')
  assert.equal(top.parentId, 'page:dest', 'kept a parent that does not exist in the destination')

  const nested = shapeForDestination(mark('shape:two', { parentId: 'shape:one' }), 'page:dest')
  assert.equal(nested.parentId, 'shape:one', 'a child was torn off the parent moving with it')
})

test("the source room's ordering index is not carried across", () => {
  const out = shapeForDestination(mark('shape:one'), 'page:dest')
  assert.equal(out.index, undefined, 'a fractional index from another room means nothing here and can collide')
})

test('moving nothing does nothing', () => {
  const source = room({ shapes: [mark('shape:one')] })
  const destination = room()

  assert.deepEqual(moveShapesToLayer(source, destination, []), [])
  assert.deepEqual(destination.log, [], 'an empty move still wrote to the destination')
  assert.deepEqual(source.log, [], 'an empty move still deleted from the source')
})
