/**
 * Is this page the classroom?
 *
 * The classroom is not a different application — it is the same document on the
 * same canvas, carrying the chrome that belongs to a course rather than the
 * chrome that belongs to tlda's own workshop.
 *
 * `?course=` is the marker, and it is not a new one. The classroom entry URL
 * carries it from registration onward: `ClassroomRegistration` builds the
 * continue link by deleting `workspace` and keeping every other parameter, so a
 * student's course URL has it, and so does the link an instructor is given.
 * `BookViewer` already keys the teacher overlay on the same parameter.
 *
 * Deliberately NOT the enrolment token. An instructor reads the course with an
 * RW bearer token and never carries one, and gating on the token is the mistake
 * that once hid the teacher view entirely — see BookViewer's note on identity
 * following the credential rather than a query parameter.
 */
export function isClassroomSurface(): boolean {
  return !!new URLSearchParams(window.location.search).get('course')
}

export function shouldResolveDocumentLayerIdentity(params: URLSearchParams): boolean {
  return !params.get('markingCourse')
}
