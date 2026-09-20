// Which sync room is which layer, and who may enter it.
//
// The room name is a fact both halves need: the client builds it to open the
// right layer, and the server parses it to decide access. One encoding, in one
// place — two regexes that agree today are two that disagree after a rename.

const STUDENT_ROOM_MARKER = '::student::'
const GRADING_DRAFT_ROOM_MARKER = '::grading-draft::'
const GRADING_RETURNED_ROOM_MARKER = '::grading-returned::'
// Which problem's marks. It goes in the STEM, before the grading-draft marker,
// never after it: `isGradingDraftRoom` asks `endsWith`, and the refusal in
// `classroomRoomAccess` is ordered above the branch that grants a submission's
// owner write. Append the problem after the marker and that refusal stops
// matching, the request falls through, and the student whose work is being
// marked is handed the instructor's private marks — with nothing looking
// broken. The marker stays terminal so the guard keeps holding.
const PROBLEM_ROOM_MARKER = '::problem::'

/** A student's own layer over a book: a coordinate on a book you already named. */
export function studentOverlayRoomId(bookRoomId, studentId) {
  return `${bookRoomId}${STUDENT_ROOM_MARKER}${studentId}`
}

/**
 * Whose private layer this room is, or null if it is not one.
 *
 * `lastIndexOf`, not `indexOf`: a student id cannot contain the marker but a
 * book's own room name is not ours to constrain, so the last occurrence is the
 * one that separates the two.
 */
export function studentOverlayRoomOwner(roomId) {
  const at = String(roomId).lastIndexOf(STUDENT_ROOM_MARKER)
  if (at < 0) return null
  const studentId = roomId.slice(at + STUDENT_ROOM_MARKER.length)
  return studentId ? { bookRoomId: roomId.slice(0, at), studentId } : null
}

/**
 * The instructor's own marking layer over one handed-in submission.
 *
 * Marking happens in his workspace and is committed to the student afterwards —
 * his June model, already written down as the `grading-draft` layer scope in
 * `wm/homework-grading-surface.ts`. That scope had no consumer: it contributed
 * to a layer id and nothing read it, so nothing was ever withheld. This is the
 * room that makes it real, because a layer IS a sync room here and privacy is
 * decided by who may enter one.
 *
 * Named after the submission room rather than the student, so flicking from one
 * student to the next changes the draft layer with the submission and marks for
 * two students can never share a room.
 */
export function gradingDraftRoomId(submissionRoomId, problemId) {
  return `${submissionRoomId}${PROBLEM_ROOM_MARKER}${problemId}${GRADING_DRAFT_ROOM_MARKER}`
}

/**
 * The same marks once returned: the copy the student may read.
 *
 * A room of its own rather than a flag on the draft, because the draft is
 * refused to the student by room name and that refusal is what withholds an
 * unfinished mark. Returning copies the store across; the draft stays private
 * so marking after a return is not visible until it is returned again.
 */
export function gradingReturnedRoomId(submissionRoomId, problemId) {
  return `${submissionRoomId}${PROBLEM_ROOM_MARKER}${problemId}${GRADING_RETURNED_ROOM_MARKER}`
}

/** Whether this room is an instructor's marking layer. */
export function isGradingDraftRoom(roomId) {
  return String(roomId).endsWith(GRADING_DRAFT_ROOM_MARKER)
}

/**
 * The submission room and problem named by a grading pane, or null.
 *
 * Both scopes, and which one it was: the caller needs the submission to ask who
 * owns it, and `returned` to tell a private draft from the copy the student may
 * read.
 */
export function gradingLayerRoomTarget(roomId) {
  const value = String(roomId)
  const marker = value.endsWith(GRADING_DRAFT_ROOM_MARKER)
    ? GRADING_DRAFT_ROOM_MARKER
    : value.endsWith(GRADING_RETURNED_ROOM_MARKER)
      ? GRADING_RETURNED_ROOM_MARKER
      : null
  if (!marker) return null
  const stem = value.slice(0, -marker.length)
  const at = stem.lastIndexOf(PROBLEM_ROOM_MARKER)
  if (at < 0) return null
  const submissionRoomId = stem.slice(0, at)
  const problemId = stem.slice(at + PROBLEM_ROOM_MARKER.length)
  return submissionRoomId && problemId
    ? { submissionRoomId, problemId, returned: marker === GRADING_RETURNED_ROOM_MARKER }
    : null
}

/**
 * What a caller may do with the annotation thread on one answer.
 *
 * Separate from `classroomRoomAccess` below and deliberately not folded into
 * it: that function's branch ORDER is its guard, and the one thing it must keep
 * refusing is a student reaching the instructor's private draft. A thread layer
 * is not the draft. Adding a case to it to serve a different object is how that
 * ordering gets disturbed, so this is its own answer.
 *
 * Skip: *"its a thread anyone can reply to anything"*, and `bookLayers.ts` has
 * no access model at all — so within an answer there is nothing to arbitrate:
 * the two people the answer belongs to may both read every layer and add one.
 * "Anyone" is the answer's participants, which is what stops it meaning the
 * whole internet.
 *
 * What this replaces: these layers were reached through the recordings routes,
 * whose guard is `requireRw`. That encoded "only the instructor authors and
 * reads layers" — true when marking was one-way, false the moment a student can
 * reply, and it made the spec unbuildable rather than merely inconvenient.
 *
 * Decided from the IDENTITY, not from the token. Skip: tokens carry identity,
 * and auth is granted to identities in the app — the unix model. So this takes
 * the resolved principal and never looks at a token level; what a caller may do
 * is a fact about who they are, and the token is only how they said so.
 *
 * Returns 'write' | 'deny'. There is no read-only case: being able to see a
 * layer and being able to answer it are the same right here.
 */
export function answerThreadAccess({ principal = null, submissionOwnerId = null }) {
  if (principal?.role === 'instructor') return 'write'
  // Nobody, or an answer whose owner we could not resolve, gets nothing.
  if (!principal?.studentId || !submissionOwnerId) return 'deny'
  return principal.studentId === submissionOwnerId ? 'write' : 'deny'
}

/**
 * What a caller may do in a room.
 *
 * Skip, on what needs gating at all: "we just need to make sure acces to student
 * jnfo is token gated." So the book and its common layer stay open to the shared
 * read link — that is what makes a public course site possible, and a gate there
 * would be the defect rather than the caution. The only new refusal is on a
 * student's own layer.
 *
 *   shared read token   read  the book and its common layer;  denied a student's
 *   enrolment token     write the book and its common layer;  write their OWN
 *   rw token            write everything
 *
 * "A student's" is two rooms, not one: their private overlay, which the room
 * name says, and the room of the work they handed in, which it does not. The
 * caller resolves the second from the submissions record and passes it as
 * `submissionOwnerId` — measured on the live course box, the shared class read
 * token was accepted into another student's submission room while the same
 * token was already refused that submission's documents over HTTP.
 *
 * Returns 'write' | 'read' | 'deny'.
 */
export function classroomRoomAccess({
  roomId,
  tokenLevel,
  studentId = null,
  submissionOwnerId = null,
  submissionReturned = false,
}) {
  if (tokenLevel === 'rw') return 'write'
  if (tokenLevel !== 'read') return 'deny'

  // The instructor's marking layer, refused to everyone the `rw` line above did
  // not already admit — including the student whose submission it hangs off.
  //
  // This sits ABOVE the `submissionOwnerId` branch deliberately. That branch
  // grants the owner 'write', and a draft room is named after their submission
  // room, so any resolver that recognised the stem would hand the student the
  // very marks being withheld from them. Ordering is the guard, not the parse.
  //
  // Unconditional, including after a return. Returning copies the draft into the
  // returned room below; the draft itself is never what the student reads. Let a
  // return open the draft instead and marking resumed afterwards is live to the
  // student the moment it is drawn, because nothing would close it again.
  if (isGradingDraftRoom(roomId)) return 'deny'

  if (gradingLayerRoomTarget(roomId)?.returned) {
    return submissionReturned && studentId === submissionOwnerId ? 'read' : 'deny'
  }

  // Handed-in work. Theirs, exactly as their own layer is theirs; a read link
  // with no enrolment behind it is nobody and gets nothing.
  if (submissionOwnerId) return studentId === submissionOwnerId ? 'write' : 'deny'

  const owner = studentOverlayRoomOwner(roomId)
  // Not a private layer: the book itself, or its common layer. Open to the link.
  if (!owner) return studentId ? 'write' : 'read'

  // A private layer is the holder's alone. An anonymous read-token visitor has
  // no layer of their own and is refused rather than given a look at somebody's.
  if (studentId && owner.studentId === studentId) return 'write'
  return 'deny'
}
