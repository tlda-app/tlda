import { useEffect, useRef, useState, type ReactNode } from 'react'
import { classroomCourseId } from './classroomToken'
import './ClassroomWorkspace.css'

/**
 * The instructor's first login, redeemed from the setup-printed handoff URL.
 *
 * Setup mints with the per-person token in memory and prints only the opaque
 * code; this page trades the code for the HttpOnly classroom cookie and then
 * leaves — the code is single-use, and the clean problems URL is the page the
 * instructor keeps. No token value ever reaches this component: the redeem
 * response carries the instructor row, the identity rides back as the cookie,
 * and the problems fetch below presents it. Children render only after the
 * redeem settles, so the gated fetch never races the login that admits it.
 */
export function ClassroomInstructorHandoff({ children }: { children: ReactNode }) {
  const params = new URLSearchParams(window.location.search)
  const courseId = params.get('course') || classroomCourseId()
  const handoffCode = params.get('handoff') || ''
  const started = useRef(false)
  const [ready, setReady] = useState(!handoffCode)
  const [error, setError] = useState('')

  useEffect(() => {
    if (started.current) return
    started.current = true
    if (!handoffCode) return
    fetch(`/api/classroom/courses/${encodeURIComponent(courseId)}/instructor-handoff/redeem`, {
      method: 'POST',
      // The identity rides back as a cookie and every later classroom fetch
      // presents it: a bare fetch sends neither, so both this call and the
      // problems fetch below must carry same-origin credentials explicitly.
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transferCode: handoffCode }),
    })
      .then(async response => {
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`)
        // The spent code leaves the URL: replaying it answers 409, so keeping
        // it in history would turn every revisit into an error page.
        const next = new URL(window.location.href)
        next.searchParams.delete('handoff')
        window.history.replaceState(null, '', next.toString())
        setReady(true)
      })
      .catch(nextError => setError((nextError as Error).message))
  }, [courseId, handoffCode])

  if (error) return <main className="classroomWorkspace classroomRegistration">
    <header><div><h1>Instructor login</h1></div></header>
    <section className="classroomTokenResult">
      <h2>Could not log in</h2>
      <p className="classroomError">{error}</p>
      <p>Run classroom setup again for a fresh login link, or ask for one from a browser where the class already works.</p>
    </section>
  </main>
  if (!ready) return <main className="classroomWorkspace classroomRegistration">
    <header><div><h1>Instructor login</h1></div></header>
    <section className="classroomTokenResult"><p>Logging you in…</p></section>
  </main>
  return <>{children}</>
}
