/**
 * Where a student's enrolment token lives between visits.
 *
 * The class link is one address handed to a whole course, so it cannot carry
 * anybody's token. Until now the token existed only in the URL registration
 * navigated to, which made that URL the student's only way back in: close the
 * tab and the shared class link answered with a registration form, which then
 * refused them for being already registered. They were holding a valid token
 * with nowhere to put it.
 *
 * The URL still wins wherever it carries one. A device-transfer link and an
 * instructor opening a student's work both name the token explicitly, and
 * neither may be overruled by whatever this browser happens to remember.
 */

const STORAGE_PREFIX = 'tlda-classroom-token'

/**
 * The course this page is about. Registration already defaulted to `qtm285`
 * when the URL named none; that default lives here now so the page that stores
 * a token and the pages that read it back cannot disagree about which course
 * they are keyed under.
 */
export function classroomCourseId(): string {
  return new URLSearchParams(window.location.search).get('course') || 'qtm285'
}

export function readClassroomToken(courseId = classroomCourseId()): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get('classroomToken')
  if (fromUrl) return fromUrl
  // Storage can be unavailable — private browsing, or a blocked third-party
  // context. That is a student who still has their own Continue link, not a
  // failure worth showing anyone, so it reads as "no remembered token".
  try {
    return window.localStorage.getItem(`${STORAGE_PREFIX}:${courseId}`)
  } catch {
    return null
  }
}

/**
 * The other place a student's enrolment token has to live: Positron's secret
 * store, which the extension's `classroom-token` URI handler writes.
 *
 * It is here rather than on the registration screen because registration is no
 * longer the only page that has a token in hand and a student who needs Positron
 * connected. A repaired student has both and never saw that screen.
 */
export function positronConnectUrl(enrollmentToken: string): string {
  const next = new URL('positron://tlda-labs.tlda-classroom/classroom-token')
  next.searchParams.set('server', window.location.origin)
  next.searchParams.set('token', enrollmentToken)
  return next.toString()
}

export function rememberClassroomToken(courseId: string, token: string): void {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}:${courseId}`, token)
  } catch {
    // See above. Forgetting costs this student their Continue link, not their work.
  }
}
