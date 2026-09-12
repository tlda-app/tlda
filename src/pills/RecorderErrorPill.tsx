/**
 * RecorderErrorPill — tells the instructor whether the lecture is being recorded.
 *
 * Lecture capture starts by itself for a publisher (`App.tsx` →
 * `openAppRecordingSession`), so nothing on screen ever says whether it worked.
 * There are two distinct silences, and both end with a lab that was not captured:
 *
 * 1. **Capture started and failed** — `startRecording` records why in
 *    `RecorderState.error` ("Microphone unavailable — …"). Until this pill
 *    nothing in `src/` read `subscribeRecorder`, so the message existed and was
 *    rendered nowhere. A platform refusal of a request made outside a user
 *    gesture is NOT in this class and sets no error — see
 *    `refusedForWantOfGesture` in `recorder.ts`.
 *
 * 2. **Capture was never attempted** — `observe()` returns early when
 *    `canPublishRecording()` is false, so no `getUserMedia`, no MediaRecorder,
 *    no draft, and *no error either*, because `startRecording` never ran. This
 *    is the one that bites on a gated course box, where the front door can hand
 *    an arriving instructor a read token: the app looks completely normal and
 *    captures nothing.
 *
 * So this reports the recorder's state rather than only its failures, and it
 * says the affirmative case too — without "Recording" on screen, the absence of
 * a warning is indistinguishable from a pill that failed to render, which is
 * exactly the reassurance-without-evidence that loses a lecture.
 *
 * Instructor-only, and deliberately: a student is not supposed to be recording,
 * so telling them they are not is noise. Role comes from the classroom identity
 * the surface already resolves; off a classroom surface this renders nothing.
 *
 * It starts no capture and holds no recorder state: the recorder remains the
 * only writer, and this is a reader of it.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getRecorderState, subscribeRecorder } from '../recording/recorder'
import { canPublishRecording, isPresentPermissionKnown, subscribeCanPresent } from '../authToken'
import { classroomApi } from '../classroom/api'
import { isClassroomSurface } from '../classroom/classroomSurface'
import './RecorderErrorPill.css'

export function RecorderErrorPill() {
  const state = useSyncExternalStore(subscribeRecorder, getRecorderState)
  const canPublish = useSyncExternalStore(subscribeCanPresent, canPublishRecording)
  const permissionKnown = useSyncExternalStore(subscribeCanPresent, isPresentPermissionKnown)
  const [isInstructor, setIsInstructor] = useState(false)
  const [showMessage, setShowMessage] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!showMessage) return
    function handleClick(e: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setShowMessage(false)
    }
    document.addEventListener('pointerdown', handleClick, true)
    return () => document.removeEventListener('pointerdown', handleClick, true)
  }, [showMessage])

  useEffect(() => {
    if (!isClassroomSurface()) return
    let cancelled = false
    classroomApi.me()
      .then(identity => { if (!cancelled) setIsInstructor(identity?.role === 'instructor') })
      .catch(() => { if (!cancelled) setIsInstructor(false) })
    return () => { cancelled = true }
  }, [])

  // Badge only, message on tap — the same disclosure BuildErrorPill uses, for
  // the same reason: the reason is a sentence, and a sentence parked in a
  // corner is a banner. A button (not a span with a handler) so a touch reaches
  // it; `onPointerDown` stops the canvas taking the tap first.
  //
  // Both failures render through this, because Skip ruled they are the same
  // kind of thing: "no recording perms is an error".
  const errorBadge = (message: string, label: string) => (
    <div className="recorder-error-container" ref={containerRef}>
      <button
        type="button"
        className="recorder-error-badge"
        onClick={() => setShowMessage(s => !s)}
        onPointerDown={e => e.stopPropagation()}
        aria-expanded={showMessage}
        aria-label={label}
        title={message}
      >&#9888;</button>
      {showMessage && (
        <div className="recorder-error-message" role="status" onPointerDown={e => e.stopPropagation()}>
          {message}
        </div>
      )}
    </div>
  )

  // A failure the recorder recorded outranks everything: it is the only case
  // that carries its own reason, and it applies whoever is looking.
  if (state.error) return errorBadge(state.error, 'Recording problem')

  // Wait for the server's answer rather than reporting a permission state
  // during the fetch — a pill that appears and then changes on every load is a
  // pill nobody reads.
  if (!permissionKnown) return null

  // The warning needs to know it is talking to an instructor, because telling a
  // student they are not recording is noise. That costs it reach: where a course
  // box hands an arriving instructor a read token, `classroomApi.me()` answers
  // `Unauthorized` rather than a role, so this stays silent for the very session
  // it was written for. Measured on `pic`, not assumed. The affirmative below is
  // what covers that case, which is why it does NOT depend on role.
  if (!canPublish) {
    if (!isInstructor) return null
    return errorBadge('Not recording — this session has no recording permission', 'Not recording')
  }

  // The affirmative: the filled dot and nothing else. Skip: "recording is a
  // like standard glyph yes?" — it is not a warning and must not read as one,
  // and the dot is the one mark everybody already knows.
  //
  // It follows the microphone, NOT the toggle. Requested-but-not-yet-capturing
  // is a real state — the platform can be waiting for a gesture — and a solid
  // dot there would tell an instructor a lecture is being recorded that is not.
  // That case is the dimmed dot, which is the one thing that must never be
  // wrong in either direction.
  if (!state.requested && state.status !== 'recording' && state.status !== 'starting') return null

  const capturing = state.status === 'recording' && !state.paused
  const label = capturing ? 'Recording' : state.paused ? 'Recording paused' : 'Starting recording'
  return (
    <div className="recorder-status-container">
      <span
        className={'recorder-status-dot' + (capturing ? '' : ' recorder-status-dot--pending')}
        role="status"
        aria-label={label}
        title={label}
      />
    </div>
  )
}
