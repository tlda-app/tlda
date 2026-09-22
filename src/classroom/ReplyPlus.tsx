/**
 * The plus that starts a reply, and the reply mode it opens.
 *
 * Skip, 2026-09-20 04:31:46: *"plus opens the like reply mode, basically like,
 * starting recording and then there is a like pause/unpause button and a send
 * button when in that mode idk and i guess a discard — like that is how
 * communication works yes?"* Compose-then-send: pressing plus begins recording
 * immediately, and the take goes nowhere until send. What plus replies *to* is
 * in `replyLayer.ts`: pressed while a layer is playing it answers that layer,
 * pressed with nothing playing it starts the answer's first layer.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from 'tldraw'
import {
  discardRecording,
  detachRecordingEditor,
  getActiveLayerRecording,
  getRecorderState,
  pauseRecording,
  resumeRecording,
  startRecording,
  stopRecording,
  subscribeRecorder,
  switchRecordingEditor,
} from '../recording/recorder'
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
  /**
   * Send the take somewhere that needs it — the return, in the marking
   * surface. Called AFTER the recording is stored, with its layer id, so the
   * mark and its track arrive together rather than as two operations that can
   * drift apart. Absent, send only stores.
   */
  onSend?: (layerId: string) => Promise<void> | void
}

export function ReplyPlus({ answer, doc, playing, editor, onLayerRecorded, onSend }: ReplyPlusProps) {
  const identityKey = `${doc}\u0000${answer.submissionRoomId}\u0000${answer.problemId}`
  const identityRef = useRef(identityKey)
  identityRef.current = identityKey
  const matchingActiveToken = useCallback(() => {
    const active = getActiveLayerRecording()
    return active && active.doc === doc
      && active.answer.submissionRoomId === answer.submissionRoomId
      && active.answer.problemId === answer.problemId
      ? active.token
      : null
  }, [answer.problemId, answer.submissionRoomId, doc])
  const [token, setToken] = useState<string | null>(() => matchingActiveToken())
  const [busy, setBusy] = useState(false)
  const [paused, setPaused] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The recorder is a single session for the whole app, so this control has to
  // follow it rather than hold its own idea of whether it is recording -- the
  // capture can stop without this button being the thing that stopped it.
  useEffect(() => subscribeRecorder((state) => {
    if (state.status === 'idle') { setToken(null); setPaused(false) }
    else {
      setToken(matchingActiveToken())
      setPaused(state.paused)
    }
    if (state.error) setError(state.error)
  }), [matchingActiveToken])

  useEffect(() => {
    setToken(matchingActiveToken())
  }, [matchingActiveToken])

  useEffect(() => {
    if (!token || !editor) return
    switchRecordingEditor(token, editor)
    return () => { detachRecordingEditor(token, editor) }
  }, [editor, token])

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
      if (identityRef.current === identityKey) setToken(started)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [answer, doc, editor, identityKey, playing])

  /**
   * Send: stop the recording, then hand the stored layer id to the take's
   * destination. Draft ink is untouched — it was already in the room the
   * moment it was drawn, and the destination (the return) carries it.
   */
  const send = useCallback(async () => {
    if (!token) return null
    setBusy(true)
    try {
      // The id the server stored it under, which is the layer's id. Announced
      // only once it is stored: a thread listing told about a layer that failed
      // to upload would show one that cannot be played.
      const layerId = await stopRecording(token)
      if (layerId) {
        onLayerRecorded?.(layerId)
        await onSend?.(layerId)
      }
      return layerId
    } catch (err) {
      setError((err as Error).message)
      return null
    } finally {
      setBusy(false)
      setToken(null)
    }
  }, [token, onLayerRecorded, onSend])

  /** Discard: drop the take without uploading. Ink stays. */
  const discard = useCallback(() => {
    if (!token) return
    setBusy(true)
    try {
      discardRecording(token)
    } finally {
      setBusy(false)
      setToken(null)
    }
  }, [token])

  const togglePause = useCallback(() => {
    if (!token) return
    if (getRecorderState().paused) resumeRecording()
    else pauseRecording()
  }, [token])

  const recording = !!token && getRecorderState().status !== 'idle'
  const kind = replyKind(playing)

  if (!recording) {
    return (
      <span className="tlda-reply-plus">
        <button
          type="button"
          disabled={busy}
          onClick={() => void start()}
          title={kind === 'reply' ? 'Reply on a new layer over this one' : 'Start marking this answer'}
          aria-label={kind === 'reply' ? 'Reply on a new layer over this one' : 'Start marking this answer'}
        >
          +
        </button>
        {error && <span className="tlda-reply-plus-error">{error}</span>}
      </span>
    )
  }

  return (
    <span className="tlda-reply-plus tlda-reply-plus-active">
      <button
        type="button"
        disabled={busy}
        onClick={togglePause}
        title={paused ? 'Resume recording' : 'Pause recording'}
        aria-label={paused ? 'Resume recording' : 'Pause recording'}
      >
        {paused ? '▶' : '❙❙'}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void send()}
        title="Send this layer"
        aria-label="Send this layer"
        className="tlda-reply-plus-send"
      >
        Send
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={discard}
        title="Discard this take — the recording is dropped, ink stays"
        aria-label="Discard this take"
      >
        ✕
      </button>
      {error && <span className="tlda-reply-plus-error">{error}</span>}
    </span>
  )
}
