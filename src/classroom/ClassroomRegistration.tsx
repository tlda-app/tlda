import { useState } from 'react'
import { classroomApi, type RegisteredStudent } from './api'
import './ClassroomWorkspace.css'

export function ClassroomRegistration() {
  const params = new URLSearchParams(window.location.search)
  const courseId = params.get('course') || 'qtm285'
  const [displayName, setDisplayName] = useState('')
  const [universityLogin, setUniversityLogin] = useState('')
  const [registration, setRegistration] = useState<RegisteredStudent | null>(null)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const register = async (event: React.FormEvent) => {
    event.preventDefault()
    if (submitting) return
    try {
      setSubmitting(true)
      setError('')
      setRegistration(await classroomApi.register(courseId, { displayName: displayName.trim(), universityLogin: universityLogin.trim() }))
    } catch (nextError) {
      setError((nextError as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return <main className="classroomWorkspace classroomRegistration">
    <header><div><h1>Register for {courseId}</h1><div>Enter the name and university login you use for class.</div></div></header>
    {!registration ? <form onSubmit={register}>
      <label>Name<input required value={displayName} onChange={event => setDisplayName(event.target.value)} autoComplete="name" /></label>
      <label>University login<input required value={universityLogin} onChange={event => setUniversityLogin(event.target.value)} autoCapitalize="none" autoCorrect="off" /></label>
      <button type="submit" disabled={submitting}>{submitting ? 'Registering…' : 'Register'}</button>
      {error && <p className="classroomError">{error}</p>}
    </form> : <section className="classroomTokenResult">
      <h2>Registration complete</h2>
      <p>Your classroom token is:</p>
      <code>{registration.enrollmentToken}</code>
      <button type="button" onClick={() => navigator.clipboard.writeText(registration.enrollmentToken)}>Copy token</button>
      <p>Keep this token. It identifies your classroom work, and the server cannot show it again.</p>
    </section>}
  </main>
}
