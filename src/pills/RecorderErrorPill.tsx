/**
 * RecorderErrorPill — shows the lecture recorder's own failure message.
 *
 * Lecture capture starts by itself for a publisher (`App.tsx` →
 * `openAppRecordingSession`), so when the microphone is unavailable there is no
 * button that visibly failed. `startRecording` already records why in
 * `RecorderState.error`, but until this pill nothing in `src/` consumed
 * `subscribeRecorder` or `getRecorderState` -- the only readers in the whole
 * repository were three lines of `appSession.test.mts`. The failure was
 * therefore invisible, and because capture is automatic the result was a
 * lecture with canvas events and silence, discoverable only on playback.
 *
 * This renders the message that already exists. It starts no capture, holds no
 * state of its own, and changes no lifecycle: the recorder remains the only
 * writer, and this is a reader of it.
 */
import { useSyncExternalStore } from 'react'
import { getRecorderState, subscribeRecorder } from '../recording/recorder'
import './RecorderErrorPill.css'

export function RecorderErrorPill() {
  const state = useSyncExternalStore(subscribeRecorder, getRecorderState)
  if (!state.error) return null

  // The text is shown rather than tucked behind a click, unlike its siblings: a
  // silent lecture is not discoverable later, so the one moment it can be
  // caught is while the person is still in the room.
  return (
    <div className="recorder-error-container">
      <span className="recorder-error-badge" aria-hidden="true">&#9888;</span>
      <span className="recorder-error-text" role="status">{state.error}</span>
    </div>
  )
}
