/**
 * PlaybackFrameShape — tldraw canvas shape that replays a fleet event stream.
 *
 * Shows chat messages and markers from a recorded playback session with a
 * scrubber UI. Events are time-filtered to the current scrubber position.
 *
 * Props:
 *   playbackId — fleet playback UUID (from GET /api/playbacks)
 *   mode       — 'free' | 'curated'
 *                'free': viewer positions shapes; scrubber controls time
 *                'curated': layout keyframes from the event stream reposition
 *                           shapes automatically as time advances
 *   w, h       — dimensions
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  stopEventPropagation,
} from 'tldraw'
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import './PlaybackFrameShape.css'

const FLEET_API = 'http://localhost:5199'
const DEFAULT_W = 480
const DEFAULT_H = 600

// --- Types ---

interface PlaybackEvent {
  t: number        // ms from start
  type: string     // 'chat' | 'marker' | 'stroke' | 'delegate' | 'task_done' | ...
  source: string
  sourceId?: string
  data: Record<string, any>
}

interface PlaybackMeta {
  id: string
  title: string
  created: string
  duration_ms: number
  time_range: { start: string | null; end: string | null }
  tags?: string[]
}

// --- Helpers ---

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatShortId(id: string): string {
  return id ? id.slice(-8) : '?'
}

function agentShortName(id: string): string {
  // fleet:6b402e4f → 6b402e4f
  return id?.replace('fleet:', '').slice(0, 8) ?? '?'
}

const NICK_COLORS = ['#7a9ec8', '#9370db', '#c8956a', '#6aafb0', '#b87a95', '#c8b060', '#c87a7a']
const nickMap = new Map<string, string>()
let nickIdx = 0
function nickColor(id: string): string {
  if (!id) return NICK_COLORS[0]
  if (!nickMap.has(id)) {
    nickMap.set(id, NICK_COLORS[nickIdx % NICK_COLORS.length])
    nickIdx++
  }
  return nickMap.get(id)!
}

// --- Component ---

function PlaybackFrameComponent({ shape }: { shape: any }) {
  const { playbackId, mode, w, h } = shape.props

  const [meta, setMeta] = useState<PlaybackMeta | null>(null)
  const [events, setEvents] = useState<PlaybackEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Scrubber state
  const [currentMs, setCurrentMs] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [playSpeed, setPlaySpeed] = useState(1)

  const rafRef = useRef<number | null>(null)
  const lastRafTime = useRef<number | null>(null)
  const feedRef = useRef<HTMLDivElement | null>(null)
  const prevEventCount = useRef(0)

  // Fetch playback data
  useEffect(() => {
    if (!playbackId) return
    setLoading(true)
    setError(null)
    setCurrentMs(0)
    setIsPlaying(false)

    fetch(`${FLEET_API}/api/playbacks/${playbackId}?format=full`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(data => {
        setMeta({
          id: data.id,
          title: data.title,
          created: data.created,
          duration_ms: data.duration_ms,
          time_range: data.time_range,
          tags: data.tags,
        })
        setEvents(data.events || [])
        setLoading(false)
      })
      .catch(e => {
        setError(e.message)
        setLoading(false)
      })
  }, [playbackId])

  // RAF-based playback tick
  const tick = useCallback((now: number) => {
    if (lastRafTime.current === null) {
      lastRafTime.current = now
    }
    const delta = (now - lastRafTime.current) * playSpeed
    lastRafTime.current = now

    setCurrentMs(prev => {
      const next = prev + delta
      if (meta && next >= meta.duration_ms) {
        setIsPlaying(false)
        return meta.duration_ms
      }
      return next
    })
    rafRef.current = requestAnimationFrame(tick)
  }, [playSpeed, meta])

  useEffect(() => {
    if (isPlaying) {
      lastRafTime.current = null
      rafRef.current = requestAnimationFrame(tick)
    } else {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      lastRafTime.current = null
    }
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [isPlaying, tick])

  // Auto-scroll feed when new events appear
  const visibleEvents = useMemo(
    () => events.filter(e => e.t <= currentMs && (e.type === 'chat' || e.type === 'marker')),
    [events, currentMs]
  )

  useEffect(() => {
    if (visibleEvents.length !== prevEventCount.current) {
      prevEventCount.current = visibleEvents.length
      if (feedRef.current) {
        feedRef.current.scrollTop = feedRef.current.scrollHeight
      }
    }
  }, [visibleEvents.length])

  const duration = meta?.duration_ms ?? 0

  function handleSeek(e: React.ChangeEvent<HTMLInputElement>) {
    const val = Number(e.target.value)
    setCurrentMs(val)
    if (isPlaying) {
      lastRafTime.current = null
    }
  }

  function handlePlayPause() {
    if (!meta || duration === 0) return
    if (currentMs >= duration) {
      setCurrentMs(0)
      setIsPlaying(true)
    } else {
      setIsPlaying(p => !p)
    }
  }

  function handleRewind() {
    setCurrentMs(0)
    setIsPlaying(false)
  }

  // Curated mode: find current section from layout keyframes
  // (markers with style 'note' or 'section' act as chapter markers)
  const currentMarker = useMemo(() => {
    if (mode !== 'curated') return null
    const visible = events.filter(e => e.t <= currentMs && e.type === 'marker')
    return visible.length > 0 ? visible[visible.length - 1] : null
  }, [mode, events, currentMs])

  const HEADER_H = 36
  const SCRUBBER_H = 64
  const feedH = h - HEADER_H - SCRUBBER_H

  return (
    <HTMLContainer
      id={shape.id}
      style={{ width: w, height: h, pointerEvents: 'all', overflow: 'hidden', borderRadius: 8 }}
    >
      <div
        className="pbf-root"
        onPointerDown={stopEventPropagation}
        onPointerMove={stopEventPropagation}
        onWheel={stopEventPropagation}
        style={{ width: w, height: h }}
      >
        {/* Header */}
        <div className="pbf-header" style={{ height: HEADER_H }}>
          <span className="pbf-title">
            {loading ? 'Loading…' : error ? 'Error' : (meta?.title ?? 'Playback')}
          </span>
          {meta && (
            <span className="pbf-meta">
              {new Date(meta.created).toLocaleDateString()} · {formatDuration(duration)}
              {mode === 'curated' && <span className="pbf-mode-badge">curated</span>}
            </span>
          )}
          {!meta && !loading && !error && (
            <span className="pbf-hint">drop a playback ID in props</span>
          )}
        </div>

        {/* Event feed */}
        <div
          className="pbf-feed"
          ref={feedRef}
          style={{ height: feedH }}
        >
          {loading && <div className="pbf-status">Loading playback…</div>}
          {error && <div className="pbf-status pbf-error">{error}</div>}
          {!loading && !error && visibleEvents.length === 0 && (
            <div className="pbf-status">No events yet — press play</div>
          )}
          {visibleEvents.map((ev, i) => {
            if (ev.type === 'marker') {
              return (
                <div key={i} className="pbf-marker">
                  <span className="pbf-marker-text">{ev.data.text}</span>
                </div>
              )
            }
            // chat
            const from = ev.data.from || ''
            const text = ev.data.text || ''
            const color = nickColor(from)
            return (
              <div key={i} className="pbf-chat-line">
                <span className="pbf-nick" style={{ color }}>{agentShortName(from)}</span>
                <span className="pbf-text">{text}</span>
              </div>
            )
          })}
        </div>

        {/* Curated mode: current chapter overlay */}
        {mode === 'curated' && currentMarker && (
          <div className="pbf-chapter">
            {currentMarker.data.text?.split('\n')[0] ?? ''}
          </div>
        )}

        {/* Scrubber */}
        <div className="pbf-scrubber" style={{ height: SCRUBBER_H }}>
          <div className="pbf-scrubber-controls">
            <button
              className="pbf-btn"
              onClick={handleRewind}
              title="Rewind"
              disabled={!meta || duration === 0}
            >⏮</button>
            <button
              className="pbf-btn pbf-play"
              onClick={handlePlayPause}
              disabled={!meta || duration === 0}
            >
              {isPlaying ? '⏸' : '▶'}
            </button>
            <select
              className="pbf-speed"
              value={playSpeed}
              onChange={e => setPlaySpeed(Number(e.target.value))}
            >
              <option value={0.25}>0.25×</option>
              <option value={0.5}>0.5×</option>
              <option value={1}>1×</option>
              <option value={2}>2×</option>
              <option value={5}>5×</option>
              <option value={10}>10×</option>
              <option value={50}>50×</option>
              <option value={100}>100×</option>
            </select>
            <span className="pbf-time">
              {formatDuration(currentMs)} / {formatDuration(duration)}
            </span>
          </div>
          <input
            className="pbf-timeline"
            type="range"
            min={0}
            max={duration || 1}
            step={100}
            value={currentMs}
            onChange={handleSeek}
            disabled={!meta || duration === 0}
          />
        </div>
      </div>
    </HTMLContainer>
  )
}

// --- Shape util ---

export class PlaybackFrameShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'playback-frame' as const
  static override props = {
    w: T.number,
    h: T.number,
    playbackId: T.string,
    mode: T.string,
  }

  getDefaultProps() {
    return {
      w: DEFAULT_W,
      h: DEFAULT_H,
      playbackId: '',
      mode: 'free',
    }
  }

  override canEdit = () => false
  override canResize = () => true
  override canBind = () => false
  override hideRotateHandle = () => true

  component(shape: any) {
    return <PlaybackFrameComponent shape={shape} />
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} rx={8} />
  }
}
