import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Editor, TLAnyShapeUtilConstructor, TLRecord, TLStateNodeConstructor } from 'tldraw'
import { IsolatedCanvasClipPanel, type ClipBounds } from '../IsolatedCanvasClipPanel'
import { getLiveAudioReplaySummary, playLiveAudioReplay, stopLiveAudioReplay } from './audioReplayBuffer'
import { liveSessionToPlaybackData } from './liveSessionPlaybackBridge'
import { fetchLiveSessionEvents, type LiveSessionEventsResponse } from './liveSessionApi'

const REPLAYABLE_SHAPES = new Set([
  'draw',
  'highlight',
  'arrow',
  'geo',
  'line',
  'text',
  'note',
  'math-note',
])

interface LiveSessionReplayProps {
  docName: string
  editor: Editor
  session: string
  active: boolean
  shapeUtils: TLAnyShapeUtilConstructor[]
  tools: TLStateNodeConstructor[]
  licenseKey: string
}

type SessionEventsResponse = LiveSessionEventsResponse

type ReplayState = 'idle' | 'paused' | 'playing'
type ReplayCamera = { x: number; y: number; z: number }

const REPLAY_PANEL_W = 360
const REPLAY_PANEL_H = 220
const REPLAY_WINDOWS = [
  { label: '5s', ms: 5_000 },
  { label: '15s', ms: 15_000 },
  { label: '60s', ms: 60_000 },
  { label: 'all', ms: 0 },
]

function isReplayableShape(rec: TLRecord | undefined): boolean {
  return !!rec && rec.typeName === 'shape' && REPLAYABLE_SHAPES.has((rec as any).type)
}

function eventLabel(ms: number) {
  return `${Math.max(0, Math.round(ms / 100) / 10).toFixed(1)}s`
}

function sortedEvents(events: SessionEventsResponse['events']) {
  return [...events].sort((a, b) => (a.t - b.t) || ((a.seq ?? 0) - (b.seq ?? 0)))
}

function sessionId(docName: string) {
  return `doc-${docName}-live`
}

function cloneReplayRecords(records: TLRecord[]): TLRecord[] {
  return records.map((rec) => {
    const clone = JSON.parse(JSON.stringify(rec))
    if (clone.typeName === 'shape') clone.isLocked = true
    return clone as TLRecord
  })
}

function replayPanelBounds(camera: ReplayCamera): ClipBounds {
  const z = camera.z || 1
  return {
    x: -camera.x,
    y: -camera.y,
    w: REPLAY_PANEL_W / z,
    h: REPLAY_PANEL_H / z,
  }
}

export function LiveSessionReplay({ docName, editor, session, active, shapeUtils, tools, licenseKey }: LiveSessionReplayProps) {
  const [state, setState] = useState<ReplayState>('idle')
  const [events, setEvents] = useState<SessionEventsResponse['events']>([])
  const [cursor, setCursor] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [replayRecords, setReplayRecords] = useState<TLRecord[]>([])
  const [replayCamera, setReplayCamera] = useState<ReplayCamera | null>(null)
  const [windowMs, setWindowMs] = useState(15_000)
  const playTimerRef = useRef<number | null>(null)
  const cursorRef = useRef(0)
  const audioStopRef = useRef<(() => void) | null>(null)

  const ordered = useMemo(() => sortedEvents(events), [events])
  const replayable = ordered.filter(e => e.kind === 'canvas' || e.kind === 'camera')
  const maxCursor = Math.max(0, replayable.length - 1)
  const current = replayable[Math.min(cursor, maxCursor)]
  const hasReplay = replayable.length > 0
  const audioSummary = getLiveAudioReplaySummary(session)
  const playbackBridge = useMemo(() => liveSessionToPlaybackData({
    id: session,
    title: `LiveKit ${docName}`,
    created: new Date().toISOString(),
    events: ordered,
    currentMs: current?.t ?? 0,
  }), [current?.t, docName, ordered, session])

  const clearTimer = useCallback(() => {
    if (playTimerRef.current) window.clearInterval(playTimerRef.current)
    playTimerRef.current = null
  }, [])

  const stopAudioReplay = useCallback(() => {
    audioStopRef.current?.()
    audioStopRef.current = null
    stopLiveAudioReplay(session)
  }, [session])

  const setReplayCursor = useCallback((next: number) => {
    cursorRef.current = next
    setCursor(next)
  }, [])

  const clearReplayStage = useCallback(() => {
    setReplayRecords([])
    setReplayCamera(null)
  }, [])

  const fetchEvents = useCallback(async () => {
    const body = await fetchLiveSessionEvents({ doc: docName, session, limit: 5000 })
    const next = sortedEvents(body.events || [])
    setEvents(next)
    return next
  }, [docName, session])

  const cursorForWindow = useCallback((replayEvents: SessionEventsResponse['events'], selectedWindowMs: number) => {
    if (!replayEvents.length) return 0
    if (!selectedWindowMs) return 0
    const latest = replayEvents.at(-1)?.t ?? 0
    const target = Math.max(0, latest - selectedWindowMs)
    const index = replayEvents.findIndex(event => event.t >= target)
    return index === -1 ? Math.max(0, replayEvents.length - 1) : index
  }, [])

  const applyCursor = useCallback((targetCursor: number, sourceEvents = events) => {
    const replayEvents = sortedEvents(sourceEvents).filter(e => e.kind === 'canvas' || e.kind === 'camera')
    if (!replayEvents.length) return
    const bounded = Math.max(0, Math.min(targetCursor, replayEvents.length - 1))
    const target = replayEvents[bounded]
    const shapes = new Map<string, TLRecord>()
    let camera: ReplayCamera | null = null

    for (const event of replayEvents) {
      if (event.t > target.t) break
      if (event.kind === 'camera') {
        camera = { x: event.x, y: event.y, z: event.z }
      } else if (event.kind === 'canvas') {
        for (const id of event.remove) shapes.delete(id)
        for (const rec of event.put) {
          if (isReplayableShape(rec)) shapes.set(String((rec as TLRecord).id), rec)
        }
      }
    }

    const records = cloneReplayRecords([...shapes.values()])
    setReplayRecords(records)
    setReplayCamera(camera ?? editor.getCamera())
    setReplayCursor(bounded)
  }, [editor, events, setReplayCursor])

  const restoreLive = useCallback(() => {
    clearTimer()
    stopAudioReplay()
    clearReplayStage()
    setState('idle')
    setReplayCursor(0)
  }, [clearReplayStage, clearTimer, setReplayCursor, stopAudioReplay])

  const startReplay = useCallback(async (selectedWindowMs = windowMs) => {
    setError(null)
    try {
      const next = await fetchEvents()
      const replayEvents = next.filter(e => e.kind === 'canvas' || e.kind === 'camera')
      if (!replayEvents.length) {
        setError('no replay events')
        return
      }
      const start = cursorForWindow(replayEvents, selectedWindowMs)
      applyCursor(start, next)
      setState('paused')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [applyCursor, cursorForWindow, fetchEvents, windowMs])

  const selectWindow = useCallback((selectedWindowMs: number) => {
    setWindowMs(selectedWindowMs)
    if (state === 'idle') return
    const replayEvents = ordered.filter(e => e.kind === 'canvas' || e.kind === 'camera')
    if (!replayEvents.length) return
    clearTimer()
    stopAudioReplay()
    applyCursor(cursorForWindow(replayEvents, selectedWindowMs))
    setState('paused')
  }, [applyCursor, clearTimer, cursorForWindow, ordered, state, stopAudioReplay])

  const step = useCallback((delta: number) => {
    if (!hasReplay) return
    clearTimer()
    stopAudioReplay()
    const next = Math.max(0, Math.min(cursorRef.current + delta, maxCursor))
    applyCursor(next)
    setState('paused')
  }, [applyCursor, clearTimer, hasReplay, maxCursor, stopAudioReplay])

  const play = useCallback(() => {
    if (!hasReplay) return
    clearTimer()
    stopAudioReplay()
    setState('playing')
    const from = replayable[Math.min(cursorRef.current, maxCursor)]?.t ?? 0
    const to = replayable[maxCursor]?.t ?? from
    const audio = playLiveAudioReplay(session, from, Math.max(to, from + 1000))
    audioStopRef.current = audio.stop
    playTimerRef.current = window.setInterval(() => {
      const next = Math.min(cursorRef.current + 1, maxCursor)
      applyCursor(next)
      if (next >= maxCursor) {
        clearTimer()
        setState('paused')
      }
    }, 300)
  }, [applyCursor, clearTimer, hasReplay, maxCursor, replayable, session, stopAudioReplay])

  const pause = useCallback(() => {
    clearTimer()
    stopAudioReplay()
    setState('paused')
  }, [clearTimer, stopAudioReplay])

  useEffect(() => restoreLive, [restoreLive])

  useEffect(() => {
    ;(window as any).__tldaLiveSessionReplay = {
      state,
      cursor,
      eventCount: events.length,
      replayableCount: replayable.length,
      current,
      replayRecordCount: replayRecords.length,
      replayCamera,
      playbackBridge,
      restoreLive,
      startReplay,
      selectWindow,
      step,
      play,
      pause,
    }
  }, [current, cursor, events.length, pause, play, playbackBridge, replayCamera, replayRecords.length, replayable.length, restoreLive, selectWindow, startReplay, state, step])

  if (!active && state === 'idle') return null

  const title = error
    ? error
    : state === 'idle'
      ? 'Start live session replay'
      : `Replay ${current ? eventLabel(current.t) : ''}${audioSummary.segments ? ` with ${audioSummary.segments} audio segment(s)` : ''}`

  return (
    <>
      <span className={`live-session-replay live-session-replay--${state}`} title={title}>
        {state === 'idle' ? (
          <button type="button" onClick={() => { void startReplay() }}>↺</button>
        ) : (
          <>
            <button type="button" onClick={() => step(-1)} disabled={cursor <= 0}>‹</button>
            <button type="button" onClick={state === 'playing' ? pause : play}>
              {state === 'playing' ? '⏸' : '▶'}
            </button>
            <button type="button" onClick={() => step(1)} disabled={cursor >= maxCursor}>›</button>
            <select
              className="live-session-replay__window"
              value={windowMs}
              onChange={e => selectWindow(Number(e.target.value))}
              title="Replay window"
            >
              {REPLAY_WINDOWS.map(option => (
                <option key={option.label} value={option.ms}>{option.label}</option>
              ))}
            </select>
            <button type="button" onClick={restoreLive}>live</button>
            <span className="live-session-replay__time">{current ? eventLabel(current.t) : sessionId(docName)}</span>
          </>
        )}
      </span>
      {state !== 'idle' && replayCamera && (
        <div className={`live-session-replay-pip live-session-replay-pip--${state}`}>
          <IsolatedCanvasClipPanel
            mainEditor={editor}
            bounds={replayPanelBounds(replayCamera)}
            shapeUtils={shapeUtils}
            tools={tools}
            licenseKey={licenseKey}
            panelWidth={REPLAY_PANEL_W}
            maxHeightFraction={1}
            readOnly
            cameraOverride={replayCamera}
            recordsOverride={replayRecords}
          />
        </div>
      )}
    </>
  )
}
