import { useEffect, useMemo, useRef, useState } from 'react'
import { classroomApi, type DeviceTransfer, type RegisteredStudent } from './api'
import { rememberClassroomToken } from './classroomToken'
import './ClassroomWorkspace.css'

export function ClassroomDeviceTransferSettings() {
  const classroomToken = new URLSearchParams(window.location.search).get('classroomToken')
  const [courseId, setCourseId] = useState('')
  const [transfer, setTransfer] = useState<DeviceTransfer | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    if (!classroomToken) return
    classroomApi.me()
      .then(identity => { if (live && identity.role === 'student') setCourseId(identity.courseId) })
      .catch(() => {})
    return () => { live = false }
  }, [classroomToken])

  if (!courseId || !classroomToken) return null

  const create = async () => {
    if (busy) return
    try {
      setBusy(true)
      setError('')
      const returnUrl = new URL(window.location.href)
      returnUrl.searchParams.delete('classroomToken')
      setTransfer(await classroomApi.createDeviceTransfer(courseId, `${returnUrl.pathname}${returnUrl.search}`))
    } catch (nextError) {
      setError((nextError as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return <div className="prefs-subsection">
    <div className="prefs-subsection-title">Classroom</div>
    <div className="classroomDeviceTransferSettings">
      <button type="button" className="prefs-btn" onClick={create} disabled={busy}>
        {busy ? 'Creating…' : 'Add this class on another device'}
      </button>
      {transfer && <div className="classroomDeviceTransferResult">
        <img src={`data:image/svg+xml,${encodeURIComponent(transfer.qrSvg)}`} alt="QR code to add this class on another device" />
        <a href={transfer.transferUrl}>Open transfer link</a>
        <button type="button" className="prefs-btn" onClick={() => navigator.clipboard.writeText(transfer.transferUrl)}>Copy link</button>
        <span>Single use; expires {new Date(transfer.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.</span>
      </div>}
      {error && <div className="classroomError">{error}</div>}
    </div>
  </div>
}

export function ClassroomDeviceTransferRedeem() {
  const params = useMemo(() => new URLSearchParams(window.location.search), [])
  const courseId = params.get('course') || ''
  const transferCode = params.get('transfer') || ''
  const started = useRef(false)
  const [registration, setRegistration] = useState<RegisteredStudent | null>(null)
  const [error, setError] = useState(() => courseId && transferCode ? '' : 'This transfer link is incomplete.')

  useEffect(() => {
    if (started.current) return
    started.current = true
    if (!courseId || !transferCode) return
    classroomApi.redeemDeviceTransfer(courseId, transferCode)
      .then(redeemed => {
        // Same reason registration remembers: this device is now the student's,
        // and a single-use transfer link cannot be replayed to get back in.
        rememberClassroomToken(courseId, redeemed.enrollmentToken)
        setRegistration(redeemed)
      })
      .catch(nextError => setError((nextError as Error).message))
  }, [courseId, transferCode])

  const continueUrl = useMemo(() => {
    if (!registration) return ''
    const next = new URL(window.location.href)
    next.searchParams.delete('workspace')
    next.searchParams.delete('transfer')
    next.searchParams.set('course', courseId)
    next.searchParams.set('classroomToken', registration.enrollmentToken)
    return next.toString()
  }, [courseId, registration])

  return <main className="classroomWorkspace classroomRegistration classroomDeviceTransferRedeem">
    <header><div><h1>Add {courseId || 'this class'} to this device</h1></div></header>
    {!registration && !error && <section className="classroomTokenResult"><p>Adding this class…</p></section>}
    {registration && <section className="classroomTokenResult">
      <h2>Class added</h2>
      <p>This device now opens the same classroom work as your other device.</p>
      <a className="classroomContinueLink" href={continueUrl}>Continue to class</a>
    </section>}
    {error && <section className="classroomTokenResult">
      <h2>Could not add this class</h2>
      <p className="classroomError">{error}</p>
      <p>Create a new link from Account on a device where the class already works.</p>
    </section>}
  </main>
}
