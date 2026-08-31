import { useEffect, useState } from 'react'
import { classroomApi, type RegisteredStudent } from './api'
import { classroomCourseId, readClassroomToken, rememberClassroomToken } from './classroomToken'
import './ClassroomWorkspace.css'

/** The class itself: the registration workspace dropped, the token carried. */
function classUrl(project: string, enrollmentToken: string): string {
  const next = new URL(window.location.href)
  next.searchParams.delete('workspace')
  next.searchParams.set('project', project)
  next.searchParams.set('classroomToken', enrollmentToken)
  return next.toString()
}

function positronUrl(enrollmentToken: string): string {
  const next = new URL('positron://tlda-labs.tlda-classroom/classroom-token')
  next.searchParams.set('server', window.location.origin)
  next.searchParams.set('token', enrollmentToken)
  return next.toString()
}

export function ClassroomRegistration() {
  const params = new URLSearchParams(window.location.search)
  const courseId = classroomCourseId()
  const project = params.get('project')
  const [displayName, setDisplayName] = useState('')
  const [universityLogin, setUniversityLogin] = useState('')
  const [registration, setRegistration] = useState<RegisteredStudent | null>(null)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Somebody who registered already is not a somebody to register again. The
  // class link is shared, so this is the same URL for everyone: a student
  // opening it a second time went to a form that answered "that university
  // login is already registered" and stopped there. Their token is remembered
  // now, so the link means "go to class" from the second visit onward.
  const remembered = readClassroomToken(courseId)
  const returning = Boolean(remembered && project && !registration)
  useEffect(() => {
    if (!returning || !project || !remembered) return
    window.location.replace(classUrl(project, remembered))
  }, [returning, project, remembered])

  const continueUrl = registration && project ? classUrl(project, registration.enrollmentToken) : null

  const register = async (event: React.FormEvent) => {
    event.preventDefault()
    if (submitting) return
    try {
      setSubmitting(true)
      setError('')
      const registered = await classroomApi.register(courseId, { displayName: displayName.trim(), universityLogin: universityLogin.trim() })
      // Remembered before it is shown, so a student who closes the tab on the
      // token screen is still enrolled on this browser rather than locked out
      // of a value the server will not print again.
      rememberClassroomToken(courseId, registered.enrollmentToken)
      setRegistration(registered)
    } catch (nextError) {
      setError((nextError as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  if (returning) return <main className="classroomWorkspace classroomRegistration">
    <header><div><h1>Register for {courseId}</h1></div></header>
    <section className="classroomTokenResult"><p>Taking you to class…</p></section>
  </main>

  return <main className="classroomWorkspace classroomRegistration">
    <header><div><h1>Register for {courseId}</h1><div>Enter the name and university login you use for class.</div></div></header>
    {!registration ? <form onSubmit={register}>
      <label>Name<input required value={displayName} onChange={event => setDisplayName(event.target.value)} autoComplete="name" /></label>
      <label>University login<input required value={universityLogin} onChange={event => setUniversityLogin(event.target.value)} autoCapitalize="none" autoCorrect="off" /></label>
      <button type="submit" disabled={submitting}>{submitting ? 'Registering…' : 'Register'}</button>
      {error && <p className="classroomError">{error}</p>}
    </form> : <section className="classroomTokenResult">
      <h2>Registration complete</h2>
      <p>This browser will remember you. The class link takes you straight in from now on.</p>
      <a className="classroomContinueLink" href={positronUrl(registration.enrollmentToken)}>Connect Positron</a>
      {continueUrl && <a className="classroomContinueLink" href={continueUrl}>Continue to class</a>}
    </section>}
  </main>
}
