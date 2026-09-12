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

  // A failure the recorder recorded outranks everything: it is the only case
  // that carries its own reason, and it applies whoever is looking.
  // Badge only, message on tap — the same disclosure BuildErrorPill uses, for
  // the same reason: the reason text is a sentence, and a sentence parked in a
  // corner is a banner. A button (not a span with a handler) so a touch reaches
  // it; `onPointerDown` stops the canvas taking the tap first.
  if (state.error) {
    return (
      <div className="recorder-error-container" ref={containerRef}>
        <button
          type="button"
          className="recorder-error-badge"
          onClick={() => setShowMessage(s => !s)}
          onPointerDown={e => e.stopPropagation()}
          aria-expanded={showMessage}
          aria-label="Recording problem"
          title={state.error}
        >&#9888;</button>
        {showMessage && (
          <div className="recorder-error-message" role="status" onPointerDown={e => e.stopPropagation()}>
            {state.error}
          </div>
        )}
      </div>
    )
  }

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
    return (
      <div className="recorder-error-container">
        <span className="recorder-error-badge" aria-hidden="true">&#9888;</span>
        <span className="recorder-error-text" role="status">
          Not recording — this session has no recording permission
        </span>
      </div>
    )
  }

  // Anyone who may publish is by definition someone who records, so this needs
  // no classroom round trip and cannot be silenced by one failing. That matters:
  // this is the indicator whose ABSENCE tells an instructor the lab is not being
  // captured, so it has to be the most robust thing here, not the least.
  if (state.status === 'recording' || state.status === 'starting') {
    const recording = state.status === 'recording'
    return (
      <div className="recorder-status-container">
        <span className={'recorder-status-dot' + (recording ? '' : ' recorder-status-dot--pending')} aria-hidden="true" />
        <span className="recorder-status-text" role="status">
          {recording ? (state.paused ? 'Recording paused' : 'Recording') : 'Starting recording'}
        </span>
      </div>
    )
  }

  return null
}
