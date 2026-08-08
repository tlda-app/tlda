import test from 'node:test'
import assert from 'node:assert/strict'
import { unreturnedMarks, returnMarks } from '../src/classroom/marking.ts'

// The point of this module is that "which marks have I not sent back" is
// answered from the room and not from tab memory. The app's own draft set is
// in-memory only, so after a reload it is empty while the shapes are still on
// the server flagged draft — marking a class is not one sitting, so that
// difference is the whole reason this exists.

function fakeEditor(shapes) {
  const byId = new Map(shapes.map(s => [s.id, s]))
  return {
    getCurrentPageShapes: () => [...byId.values()],
    updateShapes: updates => {
      for (const update of updates) byId.set(update.id, { ...byId.get(update.id), ...update })
    },
    _shapes: byId,
  }
}

const page = { id: 'shape:page1', type: 'html', meta: {} }
const draftMark = (id) => ({ id, type: 'draw', meta: { draft: true, authorId: 'tab-that-is-gone' } })
const returnedMark = (id) => ({ id, type: 'draw', meta: { draft: false } })

test('marks left over from a previous tab are still found', () => {
  // Nothing registered them in this tab's draft set — that is the case that
  // silently loses a marking session.
  const editor = fakeEditor([page, draftMark('shape:a'), draftMark('shape:b'), returnedMark('shape:c')])
  const found = unreturnedMarks(editor, new Set(['shape:page1']))
  assert.deepEqual(found.map(s => s.id).sort(), ['shape:a', 'shape:b'])
})

test('the document pages are never mistaken for marks', () => {
  const editor = fakeEditor([{ ...page, meta: { draft: true } }, draftMark('shape:a')])
  const found = unreturnedMarks(editor, new Set(['shape:page1']))
  assert.deepEqual(found.map(s => s.id), ['shape:a'])
})

test('returning clears the flag and reports how many', () => {
  const editor = fakeEditor([page, draftMark('shape:a'), draftMark('shape:b')])
  assert.equal(returnMarks(editor, new Set(['shape:page1'])), 2)
  assert.equal(editor._shapes.get('shape:a').meta.draft, false)
  assert.equal(editor._shapes.get('shape:b').meta.draft, false)
  assert.equal(unreturnedMarks(editor, new Set(['shape:page1'])).length, 0)
})

test('returning twice reports nothing the second time', () => {
  // "returned six" and "there was nothing to return" are different sentences to
  // say to someone who just spent twenty minutes marking.
  const editor = fakeEditor([page, draftMark('shape:a')])
  assert.equal(returnMarks(editor, new Set(['shape:page1'])), 1)
  assert.equal(returnMarks(editor, new Set(['shape:page1'])), 0)
})

test('already-returned marks are not touched again', () => {
  const editor = fakeEditor([page, returnedMark('shape:c')])
  assert.equal(returnMarks(editor, new Set(['shape:page1'])), 0)
})
