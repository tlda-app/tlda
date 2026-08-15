import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Tldraw, createTLStore, loadSnapshot, stopEventPropagation } from 'tldraw'
import type { TLAnyShapeUtilConstructor, TLStateNodeConstructor, TLStore, TLShapeId } from 'tldraw'
import './RecordingViewer.css'
import { getOpenPlayback, closePlayback, subscribePlaybackOpen } from '../recording/playbackController'
import { editOwnerClassInterval, getRecording, publishClassInterval, recordingAudioUrl } from '../recording/recordingApi'
import { PlaybackEngine } from '../recording/playbackEngine'
import type { RecordingMeta, RecordingEvent } from '../recording/recorder'
import { FLEET_SHAPE_TYPES } from '../shapes/fleet-utils'
import { canPublishRecording, subscribeCanPresent } from '../authToken'

interface Props {
  projectName: string
  shapeUtils: TLAnyShapeUtilConstructor[]
  tools: TLStateNodeConstructor[]
  licenseKey: string
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function recordingShapeIds(events: RecordingEvent[]): Set<string> {
  const ids = new Set<string>()
  for (const event of events) {
    if (event.kind !== 'stroke') continue
    for (const record of event.put) ids.add(record.id as string)
    for (const id of event.remove) ids.add(id)
  }
  return ids
}

function frozenPlaybackStore(
  recording: RecordingMeta,
  shapeUtils: TLAnyShapeUtilConstructor[],
): TLStore {
  const store = createTLStore({ shapeUtils })
  if (recording.baseSnapshot) loadSnapshot(store, recording.baseSnapshot)
  const replayed = recordingShapeIds(recording.events)
  const remove: TLShapeId[] = []
  for (const record of store.allRecords()) {
    if (record.typeName !== 'shape') continue
    if (replayed.has(record.id as string) || FLEET_SHAPE_TYPES.has(record.type)) remove.push(record.id as TLShapeId)
  }
  if (remove.length) store.remove(remove)
  return store
}

export function RecordingViewer({ projectName, shapeUtils, tools, licenseKey }: Props) {
  const [openId, setOpenId] = useState<string | null>(getOpenPlayback())
  const [meta, setMeta] = useState<(RecordingMeta & { privateDraft?: boolean; publication?: { state: 'candidate-clip'; startMs: number; endMs: number } | null }) | null>(null)
  const [store, setStore] = useState<TLStore | null>(null)
  const [currentMs, setCurrentMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [startMs, setStartMs] = useState(0)
  const [endMs, setEndMs] = useState(0)
  const [reviewStatus, setReviewStatus] = useState('')
  const publisher = useSyncExternalStore(subscribeCanPresent, canPublishRecording)
  const engineRef = useRef<PlaybackEngine | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const rafRef = useRef<number | null>(null)

  useEffect(() => subscribePlaybackOpen(setOpenId), [])

  useEffect(() => {
    if (!openId) {
      setMeta(null)
      setStore(null)
      return
    }
    let cancelled = false
    const privateDraft = openId.startsWith('draft:')
    const recordingId = privateDraft ? openId.slice(6) : openId
    void getRecording(projectName, recordingId, privateDraft).then((recording) => {
      if (cancelled || !recording) return
      setMeta(recording)
      setStore(frozenPlaybackStore(recording, shapeUtils))
      setCurrentMs(0)
      setPlaying(false)
      setStartMs(recording.publication?.startMs ?? 0)
      setEndMs(recording.publication?.endMs ?? recording.duration_ms)
      setReviewStatus(recording.publication ? 'Class interval proposed' : 'Private capture envelope')
    })
    return () => {
      cancelled = true
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      engineRef.current?.exit()
      engineRef.current = null
    }
  }, [openId, projectName, shapeUtils])

  const duration = meta?.duration_ms ?? 0
  const tick = () => {
    const audio = audioRef.current
    if (!audio) return
    const next = Math.min(duration, audio.currentTime * 1000)
    setCurrentMs(next)
    engineRef.current?.seek(next)
    if (!audio.paused && next < duration) rafRef.current = requestAnimationFrame(tick)
  }

  const play = () => {
    const audio = audioRef.current
    if (!audio) return
    const from = currentMs >= duration ? 0 : currentMs
    audio.currentTime = from / 1000
    void audio.play().then(() => {
      setPlaying(true)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(tick)
    }).catch(() => setPlaying(false))
  }

  const pause = () => {
    audioRef.current?.pause()
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    setPlaying(false)
  }

  const scrub = (ms: number) => {
    if (audioRef.current) audioRef.current.currentTime = ms / 1000
    setCurrentMs(ms)
    engineRef.current?.seek(ms)
  }


  const privateDraft = !!meta?.privateDraft
  const recordingId = openId?.startsWith('draft:') ? openId.slice(6) : openId
  const publishInterval = async () => {
    if (!recordingId) return
    setReviewStatus('Publishing selected interval…')
    try {
      await publishClassInterval(projectName, recordingId)
      setReviewStatus('Published')
      closePlayback()
    } catch (error) { setReviewStatus(error instanceof Error ? error.message : String(error)) }
  }
  const saveOwnerInterval = async () => {
    if (!recordingId) return
    setReviewStatus('Saving owner boundaries…')
    try {
      await editOwnerClassInterval(projectName, recordingId, startMs, endMs)
      setReviewStatus('Owner boundaries saved')
    } catch (error) { setReviewStatus(error instanceof Error ? error.message : String(error)) }
  }

  if (!openId || !meta || !store) return null
  return (
    <div className="recording-viewer" onPointerDown={stopEventPropagation} onWheel={stopEventPropagation}>
      <div className="recording-viewer__body">
        <div className="recording-viewer__canvas">
          <Tldraw
            store={store}
            shapeUtils={shapeUtils}
            tools={tools}
            licenseKey={licenseKey}
            hideUi
            forceMobile
            onMount={(editor) => {
              editor.updateInstanceState({ isReadonly: true })
              const engine = new PlaybackEngine(editor, meta.events, FLEET_SHAPE_TYPES)
              engine.enter()
              engineRef.current = engine
            }}
          />
        </div>
      </div>
      <audio
        ref={audioRef}
        src={recordingAudioUrl(projectName, recordingId!, privateDraft)}
        preload="auto"
        onEnded={() => { setPlaying(false); engineRef.current?.seek(duration); setCurrentMs(duration) }}
      />
      <div className="recording-viewer__bar">
        <button className="recording-viewer__btn" onClick={playing ? pause : play}>{playing ? '❚❚' : '▶'}</button>
        <span className="recording-viewer__time">{fmt(currentMs)}</span>
        <input
          className="recording-viewer__slider"
          type="range"
          min={0}
          max={Math.max(1, duration)}
          value={Math.min(currentMs, duration)}
          onChange={(event) => scrub(Number(event.target.value))}
        />
        <span className="recording-viewer__time">{fmt(duration)}</span>
        <button className="recording-viewer__close" onClick={closePlayback}>✕</button>
      </div>
      {privateDraft && (
        <div className="recording-viewer__review">
          <label>Start <input type="number" min={0} max={endMs / 1000} step="0.1" value={startMs / 1000} onChange={(event) => setStartMs(Number(event.target.value) * 1000)} /> s</label>
          <button onClick={() => setStartMs(Math.min(currentMs, endMs - 1))}>Set start here</button>
          <label>End <input type="number" min={startMs / 1000} max={duration / 1000} step="0.1" value={endMs / 1000} onChange={(event) => setEndMs(Number(event.target.value) * 1000)} /> s</label>
          <button onClick={() => setEndMs(Math.max(currentMs, startMs + 1))}>Set end here</button>
          {publisher
            ? <><button onClick={saveOwnerInterval}>Save my boundaries</button><button onClick={publishInterval}>Publish selected class</button></>
            : null}
          <span>{reviewStatus}</span>
        </div>
      )}
    </div>
  )
}
