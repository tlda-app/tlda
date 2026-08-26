import test from 'node:test'
import assert from 'node:assert/strict'
import { classroomRoomAccess, studentOverlayRoomId, studentOverlayRoomOwner } from '../shared/classroom-rooms.mjs'

// Who may enter which sync room.
//
// Both directions are the deliverable. A rule that refuses everything passes
// every deny test and breaks the product — and from inside a deny suite that
// looks exactly like success. So each refusal below is paired with the
// legitimate case it must NOT catch.
//
// Skip: "we just need to make sure acces to student jnfo is token gated." The
// book and its common layer stay open to the shared read link.

const BOOK = 'doc-pic-book'
const ADA = studentOverlayRoomId(BOOK, 'ada')
const BO = studentOverlayRoomId(BOOK, 'bo')

test('the public link reads the book and its common layer', () => {
  assert.equal(classroomRoomAccess({ roomId: BOOK, tokenLevel: 'read' }), 'read')
})

test("the public link is refused a student's layer", () => {
  assert.equal(classroomRoomAccess({ roomId: ADA, tokenLevel: 'read' }), 'deny')
})

test('an enrolled student writes the common layer — it is common', () => {
  assert.equal(classroomRoomAccess({ roomId: BOOK, tokenLevel: 'read', studentId: 'ada' }), 'write')
})

test('an enrolled student writes their own layer', () => {
  assert.equal(classroomRoomAccess({ roomId: ADA, tokenLevel: 'read', studentId: 'ada' }), 'write')
})

test("a student is refused another student's layer, in both directions", () => {
  assert.equal(classroomRoomAccess({ roomId: BO, tokenLevel: 'read', studentId: 'ada' }), 'deny')
  assert.equal(classroomRoomAccess({ roomId: ADA, tokenLevel: 'read', studentId: 'bo' }), 'deny')
})

test('no credential is refused everything, including the book', () => {
  assert.equal(classroomRoomAccess({ roomId: BOOK, tokenLevel: null }), 'deny')
  assert.equal(classroomRoomAccess({ roomId: ADA, tokenLevel: null }), 'deny')
})

test('an instructor is unchanged', () => {
  assert.equal(classroomRoomAccess({ roomId: BOOK, tokenLevel: 'rw' }), 'write')
  assert.equal(classroomRoomAccess({ roomId: ADA, tokenLevel: 'rw' }), 'write')
})

test('a student id that is a prefix of another does not reach it', () => {
  // 'ada' must not open 'ada2'. String containment would; equality does not.
  assert.equal(classroomRoomAccess({ roomId: studentOverlayRoomId(BOOK, 'ada2'), tokenLevel: 'read', studentId: 'ada' }), 'deny')
})

test('a book whose own name contains the marker still resolves to its last segment', () => {
  const odd = studentOverlayRoomId('doc-weird::student::thing', 'ada')
  assert.deepEqual(studentOverlayRoomOwner(odd), { bookRoomId: 'doc-weird::student::thing', studentId: 'ada' })
  assert.equal(classroomRoomAccess({ roomId: odd, tokenLevel: 'read', studentId: 'ada' }), 'write')
})

test('an ordinary document room is not mistaken for a private layer', () => {
  assert.equal(studentOverlayRoomOwner('doc-anything'), null)
  assert.equal(classroomRoomAccess({ roomId: 'doc-anything', tokenLevel: 'read' }), 'read')
})
