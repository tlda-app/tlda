// Which sync room is which layer, and who may enter it.
//
// The room name is a fact both halves need: the client builds it to open the
// right layer, and the server parses it to decide access. One encoding, in one
// place — two regexes that agree today are two that disagree after a rename.

const STUDENT_ROOM_MARKER = '::student::'

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
export function classroomRoomAccess({ roomId, tokenLevel, studentId = null, submissionOwnerId = null }) {
  if (tokenLevel === 'rw') return 'write'
  if (tokenLevel !== 'read') return 'deny'

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
