import test from 'node:test'
import assert from 'node:assert/strict'
import { unreturnedMarks, returnMarks } from '../src/classroom/marking.ts'

// Two questions this module exists to answer, and both have bitten already:
//
// Which marks are still unreturned — answered from the room, because the app's
// draft set lives only in the tab that made them and marking a class is not one
// sitting.
//
// Which marks are this student's — answered by whose block they hang from,
// because both panes share one page and a mark on his own solution is the
// common layer, not this student's feedback.

const SUBMISSION = 'shape:submission-ada'
const SOLUTION = 'shape:solution'

function fakeEditor(shapes) {
  const byId = new Map(shapes.map(s => [s.id, s]))
  return {
    getCurrentPageShapes: () => [...byId.values()],
    updateShapes: updates => { for (const u of updates) byId.set(u.id, { ...byId.get(u.id), ...u }) },
    _shapes: byId,
  }
}

const mark = (id, parentId, draft = true) => ({ id, type: 'draw', parentId, meta: { draft } })

test('marks left over from a previous tab are still found', () => {
  // Nothing registered these in this tab's draft set — the case that silently
  // loses a marking session.
  const editor = fakeEditor([
    mark('shape:a', SUBMISSION),
    mark('shape:b', SUBMISSION),
    mark('shape:c', SUBMISSION, false),
  ])
  assert.deepEqual(unreturnedMarks(editor, SUBMISSION).map(s => s.id).sort(), ['shape:a', 'shape:b'])
})

test("a mark on his own solution is not returned to the student", () => {
  // The common layer: written once, for everyone. Returning it with this
  // student's feedback would hand them the annotations meant for the class.
  const editor = fakeEditor([
    mark('shape:hers', SUBMISSION),
    mark('shape:common', SOLUTION),
  ])
  assert.deepEqual(unreturnedMarks(editor, SUBMISSION).map(s => s.id), ['shape:hers'])
  assert.equal(returnMarks(editor, SUBMISSION), 1)
  assert.equal(editor._shapes.get('shape:common').meta.draft, true, 'the common mark was handed to one student')
})

test("another student's marks are never returned by this one", () => {
  const editor = fakeEditor([
    mark('shape:ada', SUBMISSION),
    mark('shape:bo', 'shape:submission-bo'),
  ])
  assert.equal(returnMarks(editor, SUBMISSION), 1)
  assert.equal(editor._shapes.get('shape:bo').meta.draft, true, "Bo's marks were returned while marking Ada")
})

test('the document pages are never mistaken for marks', () => {
  const editor = fakeEditor([
    { id: SUBMISSION, type: 'html', parentId: 'page:main', meta: { draft: true } },
    mark('shape:a', SUBMISSION),
  ])
  assert.deepEqual(unreturnedMarks(editor, SUBMISSION).map(s => s.id), ['shape:a'])
})

test('returning clears the flag and reports how many', () => {
  const editor = fakeEditor([mark('shape:a', SUBMISSION), mark('shape:b', SUBMISSION)])
  assert.equal(returnMarks(editor, SUBMISSION), 2)
  assert.equal(editor._shapes.get('shape:a').meta.draft, false)
  assert.equal(unreturnedMarks(editor, SUBMISSION).length, 0)
})

test('returning twice reports nothing the second time', () => {
  const editor = fakeEditor([mark('shape:a', SUBMISSION)])
  assert.equal(returnMarks(editor, SUBMISSION), 1)
  assert.equal(returnMarks(editor, SUBMISSION), 0)
})
