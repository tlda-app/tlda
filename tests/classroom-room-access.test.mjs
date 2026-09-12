import test from 'node:test'
import assert from 'node:assert/strict'
import { classroomRoomAccess, gradingDraftRoomId, studentOverlayRoomId, studentOverlayRoomOwner } from '../shared/classroom-rooms.mjs'

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

// A submission's room is the other room that is one student's, and unlike the
// overlay the NAME does not say so — `doc-submission-<assignment>-<student>` is
// an ordinary document room to look at. Measured on the live course box: the
// shared class read token was accepted into another student's submission room
// while the same token was already refused that submission's documents over
// HTTP. The caller resolves the owner from the submissions record and passes it.

const SUBMISSION_ROOM = 'doc-submission-hw-minus-1-setup-qtm285:ada'

test("a submission's room is refused to the class read link and to a classmate", () => {
  assert.equal(classroomRoomAccess({ roomId: SUBMISSION_ROOM, tokenLevel: 'read', submissionOwnerId: 'qtm285:ada' }), 'deny')
  assert.equal(classroomRoomAccess({
    roomId: SUBMISSION_ROOM, tokenLevel: 'read', studentId: 'qtm285:bo', submissionOwnerId: 'qtm285:ada',
  }), 'deny')
})

test('the student who handed it in keeps their submission room, and so does the instructor', () => {
  assert.equal(classroomRoomAccess({
    roomId: SUBMISSION_ROOM, tokenLevel: 'read', studentId: 'qtm285:ada', submissionOwnerId: 'qtm285:ada',
  }), 'write')
  assert.equal(classroomRoomAccess({ roomId: SUBMISSION_ROOM, tokenLevel: 'rw', submissionOwnerId: 'qtm285:ada' }), 'write')
})

test('nothing changes for a room that is not a submission', () => {
  // The caller passes null when the record says the room is not one, which is
  // every book and every common layer. This is the control that says the new
  // parameter cannot narrow anything it was not given.
  assert.equal(classroomRoomAccess({ roomId: BOOK, tokenLevel: 'read', submissionOwnerId: null }), 'read')
  assert.equal(classroomRoomAccess({ roomId: BOOK, tokenLevel: 'read', studentId: 'ada', submissionOwnerId: null }), 'write')
  assert.equal(classroomRoomAccess({ roomId: ADA, tokenLevel: 'read', studentId: 'ada', submissionOwnerId: null }), 'write')
})

// --- the instructor's marking layer ---
//
// A layer is a sync room, so "withheld until returned" is decided here: the
// grading draft is a room the student cannot enter. Nothing else in the marking
// path can withhold a mark, because the panes write to one shared store.

const GRADING_DRAFT = gradingDraftRoomId(SUBMISSION_ROOM)

test('the marking layer is refused to the student whose submission it hangs off', () => {
  // The one that matters. The draft room is named after Ada's submission room,
  // and Ada may write that submission room — so if the draft check sat below the
  // submission-owner branch she would be handed the marks being withheld.
  assert.equal(classroomRoomAccess({
    roomId: GRADING_DRAFT, tokenLevel: 'read', studentId: 'qtm285:ada', submissionOwnerId: 'qtm285:ada',
  }), 'deny')
})

test('the marking layer is refused to a classmate and to the class read link', () => {
  assert.equal(classroomRoomAccess({
    roomId: GRADING_DRAFT, tokenLevel: 'read', studentId: 'qtm285:bo', submissionOwnerId: 'qtm285:ada',
  }), 'deny')
  assert.equal(classroomRoomAccess({ roomId: GRADING_DRAFT, tokenLevel: 'read' }), 'deny')
})

test('the instructor may write their own marking layer', () => {
  // Without this the refusals above would pass on a rule that locked everyone
  // out, which withholds marks by making them impossible to make.
  assert.equal(classroomRoomAccess({ roomId: GRADING_DRAFT, tokenLevel: 'rw' }), 'write')
})

test('naming a draft layer does not narrow the submission room it hangs off', () => {
  // The control for the marker itself: the stem must keep behaving exactly as it
  // did, or this change withholds the returned work too.
  assert.equal(classroomRoomAccess({
    roomId: SUBMISSION_ROOM, tokenLevel: 'read', studentId: 'qtm285:ada', submissionOwnerId: 'qtm285:ada',
  }), 'write')
  assert.equal(classroomRoomAccess({ roomId: BOOK, tokenLevel: 'read' }), 'read')
})
