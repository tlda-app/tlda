/**
 * Who said a layer in an answer's marking thread.
 *
 * A thread layer is stored as a recording carrying `answer` (+ optional
 * `parent`); the drafts listing already exposes the thread's shape, but
 * nothing says WHO recorded a layer — the player reads "1. 00:12 ↳" with no
 * speaker. The author is derived server-side from the resolved classroom
 * principal at record time, never supplied by the client: a caller who could
 * name their own author could speak as the other side of the thread.
 *
 * Lectures carry no author: a lecture answers nobody, and stamping one would
 * change every existing row's shape for a thread it does not belong to.
 */

/**
 * @typedef {{ role: 'student', studentId: string, displayName?: string, preferredName?: string } | { role: 'instructor', instructorId?: string, displayName?: string, preferredName?: string } | null} ThreadPrincipal
 * @typedef {{ role: 'instructor' } | { role: 'student', studentId: string }} LayerAuthor
 */

/**
 * Derive a stored thread layer's author from the caller's resolved identity.
 *
 * Returns null for a lecture (no answer) and for an identity that resolves to
 * nobody — both store nothing rather than a claimed author.
 */
export function threadLayerAuthor({ principal = null, answer = null }) {
  if (!answer?.submissionRoomId) return null
  if (principal?.role === 'instructor') return { role: 'instructor' }
  if (principal?.role === 'student' && principal.studentId) {
    return { role: 'student', studentId: principal.studentId }
  }
  return null
}

/**
 * Whether a stored author belongs to the thread it is filed under.
 *
 * A lecture has neither answer nor author, so there is nothing to check. A
 * student author must be the answer's own student: `answerThreadAccess`
 * admitted exactly that student and the instructor, so any other student id
 * on the row is a write that could not have passed the gate.
 */
export function threadAuthorBelongsToAnswer({ author = null, answer = null, submissionOwnerId = null }) {
  if (!answer?.submissionRoomId) return true
  if (!author) return false
  if (author.role === 'instructor') return true
  if (author.role !== 'student') return false
  return !!submissionOwnerId && author.studentId === submissionOwnerId
}

/**
 * What the player shows for a layer's speaker.
 *
 * The instructor's display name is not resolved here: the row carries the
 * stable identity, and the client renders a fixed "Instructor" label rather
 * than joining a name that can change. A student's own row reads "You" to
 * them and "Student" to the instructor — decided by the viewer, so this takes
 * the viewer rather than baking one side's reading into the row.
 *
 * @param {{ author?: LayerAuthor | null, viewer?: ThreadPrincipal }} input
 * @returns {string | null}
 */
export function threadSpeakerLabel({ author = null, viewer = null }) {
  if (!author) return null
  if (author.role === 'instructor') return 'Instructor'
  if (author.role !== 'student') return null
  if (viewer?.role === 'student' && viewer.studentId === author.studentId) return 'You'
  return 'Student'
}
