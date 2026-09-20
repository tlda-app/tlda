/**
 * The plus that starts a reply.
 *
 * Skip, asked what starts one: *"and oike idk bro add a plus you know"* — so it
 * is a plus, and it is not a question that wanted a design. What it does is in
 * `replyLayer.ts`: pressed while a layer is playing it answers that layer,
 * pressed with nothing playing it starts the answer's first layer.
 *
 * Pressing it begins recording immediately rather than opening anything. A
 * reply is ink and voice on a new layer, and both start at the same instant as
 * the warp that maps this layer onto the one underneath — putting a dialog in
 * between would mean the first thing said is said before the recording exists.
 */

import { useCallback, useEffect, useState } from 'react'
import type { Editor } from 'tldraw'
import { getRecorderState, startRecording, stopRecording, subscribeRecorder } from '../recording/recorder'
import type { AnswerRef } from '../recording/recorder'
import { replyKind, replyTarget, type PlayingLayer } from './replyLayer'
import './ReplyPlus.css'

export interface ReplyPlusProps {
  /** Which answer's thread this plus adds to. */
  answer: AnswerRef
  /** The project the layer is stored under. */
  doc: string
  /** The layer open in front of the reader, if one is playing. */
  playing?: PlayingLayer | null
  /** The editor whose ink belongs to this layer; audio-only without one. */
  editor?: Editor | null
  /** Called once a layer is stored, so a thread listing can pick it up. */
  onLayerRecorded?: (layerId: string) => void
}

export function ReplyPlus({ answer, doc, playing, editor, onLayerRecorded }: ReplyPlusProps) {
  const [token, setToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The recorder is a single session for the whole app, so this control has to
  // follow it rather than hold its own idea of whether it is recording -- the
  // capture can stop without this button being the thing that stopped it.
  useEffect(() => subscribeRecorder((state) => {
    if (state.status === 'idle') setToken(null)
    if (state.error) setError(state.error)
  }), [])

  const start = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const started = await startRecording(editor ?? null, doc, {
        userInitiated: true,
        layer: replyTarget(answer, playing),
      })
      // Null is the platform asking for a gesture it did not get, which the
      // recorder reports on its own; it is not this control's failure to
      // announce a second time.
      setToken(started)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [answer, doc, editor, playing])

  const finish = useCallback(async () => {
    if (!token) return
    setBusy(true)
    try {
      // The id the server stored it under, which is the layer's id. Announced
      // only once it is stored: a thread listing told about a layer that failed
      // to upload would show one that cannot be played.
      const layerId = await stopRecording(token)
      if (layerId) onLayerRecorded?.(layerId)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
      setToken(null)
    }
  }, [token, onLayerRecorded])

  const recording = !!token && getRecorderState().status !== 'idle'
  const kind = replyKind(playing)

  return (
    <span className="tlda-reply-plus">
      <button
        type="button"
        disabled={busy}
        onClick={() => void (recording ? finish() : start())}
        // Which of the two acts this is, because the control looks the same
        // either way and "answer this" is not "start marking".
        title={recording
          ? 'Finish this layer'
          : kind === 'reply' ? 'Reply on a new layer over this one' : 'Start marking this answer'}
        aria-label={recording
          ? 'Finish this layer'
          : kind === 'reply' ? 'Reply on a new layer over this one' : 'Start marking this answer'}
        className={recording ? 'tlda-reply-plus-recording' : undefined}
      >
        {recording ? '■' : '+'}
      </button>
      {error && <span className="tlda-reply-plus-error">{error}</span>}
    </span>
  )
}
