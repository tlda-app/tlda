/**
 * useDocViewPlayback — one doc-view's playback state.
 *
 * This was `RecordingViewer`'s local state, when there was one floating window
 * playing one recording. A doc-view can show a recording in its body and there
 * can be several doc-views, so it had to become something each shape holds its
 * own copy of.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor, TLStore } from 'tldraw'
import { PlaybackEngine } from './playbackEngine'
import type { RecordingMeta } from './recorder'
import { getRecording, recordingAudioUrl, type RecordingSummary } from './recordingApi'
import { FLEET_SHAPE_TYPES } from '../shapes/fleet-utils'
import { documentShapeUtils, frozenPlaybackStore, parseRecordingRef } from './docViewPlayback'

/**
 * `HTMLMediaElement.HAVE_METADATA` — enough of the track has loaded for
 * `currentTime` to mean something. Named rather than written as `1` because the
 * whole reconcile below turns on it, and a bare `>= 1` reads as arbitrary.
 */
const HAVE_METADATA = 1

export type LoadedRecording = RecordingMeta & {
  privateDraft?: boolean
  publication?: RecordingSummary['publication']
}

export interface DocViewPlayback {
  meta: LoadedRecording | null
  store: TLStore | null
  currentMs: number
  duration: number
  playing: boolean
  muted: boolean
  hasAudio: boolean
  /** Callback ref for the transport's `<audio>`; the hook owns the element. */
  attachAudio: (el: HTMLAudioElement | null) => void
  audioSrc: string | null
  play: () => void
  pause: () => void
  scrub: (ms: number) => void
  setMuted: (muted: boolean) => void
  noteAudioMissing: () => void
  onEditorMount: (editor: Editor) => void
}

/**
 * Fetch a recording, freeze a store for it, and run a clock over it.
 *
 * The clock is `performance.now()` rather than the audio element's
 * `currentTime`, which is what `RecordingViewer` used. Audio drove the clock
 * there, so a recording with no audio track could not advance at all — and mute
 * has to keep the drawing playing, which an audio-driven clock cannot do. Audio
 * is now a sound source that gets seeked alongside, and playback survives it
 * being absent, muted, or refused by autoplay.
 */
export function useDocViewPlayback(projectName: string, ref: string | undefined): DocViewPlayback {
  const selection = parseRecordingRef(ref)
  const recordingId = selection?.id ?? null
  const privateDraft = !!selection?.privateDraft

  const [meta, setMeta] = useState<LoadedRecording | null>(null)
  const [store, setStore] = useState<TLStore | null>(null)
  const [currentMs, setCurrentMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [muted, setMutedState] = useState(false)
  const [hasAudio, setHasAudio] = useState(false)

  const engineRef = useRef<PlaybackEngine | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const rafRef = useRef<number | null>(null)
  // Wall-clock origin: the moment that corresponds to t=0 of the recording.
  const originRef = useRef(0)

  const duration = meta?.duration_ms ?? 0

  useEffect(() => {
    if (!recordingId) {
      setMeta(null)
      setStore(null)
      return
    }
    let cancelled = false
    const shapeUtils = documentShapeUtils()
    void getRecording(projectName, recordingId, privateDraft).then((recording) => {
      if (cancelled || !recording || !shapeUtils) return
      setMeta(recording)
      setStore(frozenPlaybackStore(recording, shapeUtils))
      setCurrentMs(0)
      setPlaying(false)
      setHasAudio(!!recording.audioMime)
    })
    return () => {
      cancelled = true
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      engineRef.current?.exit()
      engineRef.current = null
    }
  }, [projectName, recordingId, privateDraft])

  const stopClock = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
  }, [])

  useEffect(() => stopClock, [stopClock])

  const pause = useCallback(() => {
    audioRef.current?.pause()
    stopClock()
    setPlaying(false)
  }, [stopClock])

  const play = useCallback(() => {
    if (duration <= 0) return
    const from = currentMs >= duration ? 0 : currentMs
    originRef.current = performance.now() - from
    const audio = audioRef.current
    if (audio) {
      audio.currentTime = from / 1000
      // A refused or missing track is not a reason not to play the drawing.
      void audio.play().catch(() => {})
    }
    setPlaying(true)
    const tick = () => {
      // Audio IS the recorded timeline whenever it is actually running, so the
      // origin is re-derived from it every frame. `RecordingViewer` drove the
      // drawing straight off `audio.currentTime`, which meant picture and sound
      // could not drift — a guarantee it had by construction and never wrote
      // down. Seeking once at `play()` and then free-running loses it: a
      // buffering stall or any rate difference desynchronises them permanently
      // for that playback.
      //
      // NOT gated on unmuted. A muted element still advances `currentTime` —
      // muting changes output, not the clock. Gating on it would hand clock
      // authority back and forth on a volume control, so pressing mute would
      // make the drawing free-run and unmuting would snap it, which is a worse
      // artifact than the drift. It also abandons sync for someone watching
      // muted, who is watching the picture and needs it most.
      //
      // The wall clock stays authoritative for exactly the three cases this
      // clock was changed for: no audio track, autoplay refused, and audio
      // errored. All three leave the element paused or without metadata.
      const runningAudio = audioRef.current
      if (runningAudio && runningAudio.readyState >= HAVE_METADATA && !runningAudio.paused) {
        originRef.current = performance.now() - runningAudio.currentTime * 1000
      }
      const next = Math.min(duration, performance.now() - originRef.current)
      setCurrentMs(next)
      engineRef.current?.seek(next)
      if (next >= duration) {
        audioRef.current?.pause()
        rafRef.current = null
        setPlaying(false)
        return
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    stopClock()
    rafRef.current = requestAnimationFrame(tick)
  }, [currentMs, duration, stopClock])

  const scrub = useCallback((ms: number) => {
    const clamped = Math.max(0, Math.min(duration, ms))
    originRef.current = performance.now() - clamped
    if (audioRef.current) audioRef.current.currentTime = clamped / 1000
    setCurrentMs(clamped)
    engineRef.current?.seek(clamped)
  }, [duration])

  const setMuted = useCallback((next: boolean) => {
    setMutedState(next)
    if (audioRef.current) audioRef.current.muted = next
  }, [])

  const noteAudioMissing = useCallback(() => setHasAudio(false), [])

  const attachAudio = useCallback((el: HTMLAudioElement | null) => {
    audioRef.current = el
    if (el) el.muted = muted
  }, [muted])

  const onEditorMount = useCallback((editor: Editor) => {
    if (!meta) return
    editor.updateInstanceState({ isReadonly: true })
    const engine = new PlaybackEngine(editor, meta.events, FLEET_SHAPE_TYPES)
    engine.enter()
    engineRef.current = engine
  }, [meta])

  return {
    meta,
    store,
    currentMs,
    duration,
    playing,
    muted,
    hasAudio,
    attachAudio,
    audioSrc: recordingId ? recordingAudioUrl(projectName, recordingId, privateDraft) : null,
    play,
    pause,
    scrub,
    setMuted,
    noteAudioMissing,
    onEditorMount,
  }
}
