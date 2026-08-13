/**
 * The place stack, against Skip's specification.
 *
 * > we maintain a place stack. Right? … there's a place stack can go forward
 * > and back in. Like, a browser has that.
 * > Where a place is a document.
 *
 * The load-bearing case is the last test: back has to take you OUT of a
 * Markdown document, not to your previous scroll position inside it. A stack
 * that pushes every in-page hop passes every other test here and still fails
 * the thing it was built for.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { departFrom, emptyPlaceStack, stepBack, stepForward } from '../src/placeStackCore.ts'

const at = (documentId, x = 0) => ({ documentId, pageId: 'page:1', camera: { x, y: 0, z: 1 } })

test('going somewhere new records where you were', () => {
  const stack = departFrom(emptyPlaceStack, at('paper'))
  assert.deepEqual(stack.back.map(p => p.documentId), ['paper'])
  assert.equal(stack.forward.length, 0)
})

test('back returns to the previous document and offers forward', () => {
  let stack = departFrom(emptyPlaceStack, at('paper'))
  const { target, next } = stepBack(stack, at('outline'))
  assert.equal(target.documentId, 'paper', 'back lands in the document you came from')
  stack = next
  assert.equal(stack.back.length, 0)
  assert.deepEqual(stack.forward.map(p => p.documentId), ['outline'], 'where you left becomes forward')

  const forward = stepForward(stack, at('paper'))
  assert.equal(forward.target.documentId, 'outline')
  assert.equal(forward.next.forward.length, 0)
  assert.deepEqual(forward.next.back.map(p => p.documentId), ['paper'])
})

test('a fresh move abandons forward history, as a browser does', () => {
  let stack = departFrom(emptyPlaceStack, at('paper'))
  stack = stepBack(stack, at('outline')).next
  assert.equal(stack.forward.length, 1, 'precondition: there is forward history to abandon')

  stack = departFrom(stack, at('paper'))
  assert.equal(stack.forward.length, 0)
})

test('back gets you OUT of a document, not to your last scroll position in it', () => {
  // Enter the outline from the paper, then follow three links inside it.
  let stack = departFrom(emptyPlaceStack, at('paper'))
  stack = departFrom(stack, at('outline', 10))
  stack = departFrom(stack, at('outline', 20))
  stack = departFrom(stack, at('outline', 30))

  assert.deepEqual(
    stack.back.map(p => p.documentId),
    ['paper', 'outline'],
    'three hops inside the outline are one entry, not three',
  )

  const { target } = stepBack(stack, at('outline', 40))
  assert.equal(target.documentId, 'outline')
  assert.equal(target.camera.x, 30, 'and it is the latest view of it, not the first')

  // One more back and you are out.
  const out = stepBack(stepBack(stack, at('outline', 40)).next, at('outline', 30))
  assert.equal(out.target.documentId, 'paper')
})

test('back and forward do nothing when there is nowhere to go', () => {
  assert.equal(stepBack(emptyPlaceStack, at('paper')).target, null)
  assert.equal(stepForward(emptyPlaceStack, at('paper')).target, null)
  assert.deepEqual(stepBack(emptyPlaceStack, at('paper')).next, emptyPlaceStack)
})
