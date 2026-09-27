import test from 'node:test'
import assert from 'node:assert/strict'
import { departFrom, emptyPlaceStack, stepBack, stepForward } from '../src/placeStackCore.ts'

// Book chapters share one spatial document id (`spatial-primary:<book>`), so
// the coalesce key has to include the member: ch1 → ch2 → ch1 must stack three
// entries, or back can never cross chapters.

const cam = (y) => ({ x: 200, y, z: 1 })
const BOOK = 'spatial-primary:scratch-book'

test('departures from different members of one book stack, not coalesce', () => {
  let stack = emptyPlaceStack
  stack = departFrom(stack, { documentId: BOOK, pageId: 'page:page', camera: cam(50), memberKey: 'ch1' })
  stack = departFrom(stack, { documentId: BOOK, pageId: 'page:page', camera: cam(60), memberKey: 'ch2' })
  stack = departFrom(stack, { documentId: BOOK, pageId: 'page:page', camera: cam(70), memberKey: 'ch1' })
  assert.equal(stack.back.length, 3)
  assert.deepEqual(stack.back.map(p => p.memberKey), ['ch1', 'ch2', 'ch1'])
})

test('consecutive departures from the same member still coalesce', () => {
  let stack = emptyPlaceStack
  stack = departFrom(stack, { documentId: BOOK, pageId: 'page:page', camera: cam(50), memberKey: 'ch1' })
  stack = departFrom(stack, { documentId: BOOK, pageId: 'page:page', camera: cam(167), memberKey: 'ch1' })
  assert.equal(stack.back.length, 1)
  assert.equal(stack.back[0].camera.y, 167)
})

test('places without a member keep the old document-only rule', () => {
  let stack = emptyPlaceStack
  stack = departFrom(stack, { documentId: 'spatial-primary:paper', pageId: 'page:page', camera: cam(1) })
  stack = departFrom(stack, { documentId: 'spatial-primary:paper', pageId: 'page:page', camera: cam(2) })
  assert.equal(stack.back.length, 1)
  stack = departFrom(stack, { documentId: 'spatial-primary:other', pageId: 'page:page', camera: cam(3) })
  assert.equal(stack.back.length, 2)
})

test('a member place and a memberless place for one document do not coalesce', () => {
  let stack = emptyPlaceStack
  stack = departFrom(stack, { documentId: BOOK, pageId: 'page:page', camera: cam(1), memberKey: 'ch1' })
  stack = departFrom(stack, { documentId: BOOK, pageId: 'page:page', camera: cam(2) })
  assert.equal(stack.back.length, 2)
})

test('back and forward carry the member through', () => {
  let stack = emptyPlaceStack
  stack = departFrom(stack, { documentId: BOOK, pageId: 'page:page', camera: cam(50), memberKey: 'ch1' })
  const here = { documentId: BOOK, pageId: 'page:page', camera: cam(60), memberKey: 'ch2' }
  const back = stepBack(stack, here)
  assert.equal(back.target?.memberKey, 'ch1')
  assert.equal(back.next.forward[0]?.memberKey, 'ch2')
  const fwd = stepForward(back.next, { documentId: BOOK, pageId: 'page:page', camera: cam(50), memberKey: 'ch1' })
  assert.equal(fwd.target?.memberKey, 'ch2')
})
