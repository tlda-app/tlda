/**
 * PlaybackFrameShape — tldraw frame shape that replays a fleet event stream.
 *
 * This shape acts as a container (frame) for other tldraw shapes — primarily
 * FleetChatShape and FleetAgentsShape. Those child shapes read from a saved
 * event recording instead of the live WebSocket because PlaybackFrameShape
 * registers itself in the playback-context registry, and fleet-data-adapter
 * hooks check that registry before falling through to live SSE data.
 *
 * Architecture:
 *   1. User places PlaybackFrameShape on canvas, sets playbackId prop
 *   2. User adds FleetChatShape (or other fleet shapes) as tldraw children
 *      (parentId = PlaybackFrame's shape ID)
 *   3. This shape fetches the recording, registers in playback-context
 *   4. As scrubber advances, updatePlayback() is called → subscriber callbacks
 *      fire → FleetChatShape re-renders with time-filtered events
 *   5. Curated mode: layout keyframe events reposition children via
 *      editor.store.mergeRemoteChanges() (ephemeral, not synced to Yjs)
 *
 * Props:
 *   playbackId — fleet playback UUID
 *   mode       — 'free' | 'curated'
 *   w, h       — frame dimensions (includes scrubber chrome height)
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  stopEventPropagation,
  useEditor,
} from 'tldraw'
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  updatePlayback,
  unregisterPlayback,
  getLayoutKeyframe,
  type PlaybackData,
} from '../playback-context'
import './PlaybackFrameShape.css'

const FLEET_API = 'http://localhost:5199'
const DEFAULT_W = 500
const DEFAULT_H = 80   // frame is mostly the chrome; content comes from child shapes
const SCRUBBER_H = 64
const HEADER_H = 36

// --- Helpers ---

function formatDuration(ms: number): string {
  if (!ms || ms < 0) return '0:00'
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

// --- Component ---

function PlaybackFrameComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const { playbackId, mode, w, h } = shape.props

  const [pbData, setPbData] = useState<PlaybackData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Scrubber state (local — not synced to Yjs)
  const [currentMs, setCurrentMs] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [playSpeed, setPlaySpeed] = useState(1)
  const [speedText, setSpeedText] = useState('1')

  const rafRef = useRef<number | null>(null)
  const lastRafTime = useRef<number | null>(null)

  // Fetch recording on playbackId change
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
        // Build agent list from sources
        const agentIds: string[] = []
        for (const src of data.sources || []) {
          for (const id of src.agents || []) {
            if (!agentIds.includes(id)) agentIds.push(id)
          }
        }

        const pb: PlaybackData = {
          events: data.events || [],
          agents: agentIds.map((id: string) => ({
            id,
            friendly_name: null,
          })),
          currentMs: 0,
          duration_ms: data.duration_ms || 0,
          title: data.title || 'Untitled',
          created: data.created || new Date().toISOString(),
        }
        setPbData(pb)
        updatePlayback(shape.id, pb)
        setLoading(false)
      })
      .catch(e => {
        setError(e.message)
        setLoading(false)
      })

    return () => unregisterPlayback(shape.id)
  }, [playbackId, shape.id])

  // Update registry whenever currentMs changes
  useEffect(() => {
    if (!pbData) return
    const updated = { ...pbData, currentMs }
    updatePlayback(shape.id, updated)
  }, [currentMs, pbData, shape.id])

  // Curated mode: apply layout keyframes when currentMs changes
  useEffect(() => {
    if (mode !== 'curated' || !pbData) return
    const layout = getLayoutKeyframe({ ...pbData, currentMs })
    if (!layout) return

    // Apply layout positions ephemerally (mergeRemoteChanges = not pushed to Yjs)
    editor.store.mergeRemoteChanges(() => {
      for (const [childId, pos] of Object.entries(layout)) {
        const child = editor.getShape(childId as any)
        if (child && child.parentId === shape.id) {
          editor.updateShape({ id: childId as any, type: child.type, x: pos.x, y: pos.y })
        }
      }
    })
  }, [currentMs, mode, pbData, shape.id, editor])

  // Unregister on unmount
  useEffect(() => {
    return () => unregisterPlayback(shape.id)
  }, [shape.id])

  // RAF-based playback tick
  const tick = useCallback((now: number) => {
    if (lastRafTime.current === null) {
      lastRafTime.current = now
    }
    const delta = (now - lastRafTime.current) * playSpeed
    lastRafTime.current = now

    setCurrentMs(prev => {
      if (!pbData) return prev
      const next = prev + delta
      if (next >= pbData.duration_ms) {
        setIsPlaying(false)
        return pbData.duration_ms
      }
      return next
    })
    rafRef.current = requestAnimationFrame(tick)
  }, [playSpeed, pbData])

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

  const duration = pbData?.duration_ms ?? 0

  function handleSeek(e: React.ChangeEvent<HTMLInputElement>) {
    setCurrentMs(Number(e.target.value))
    if (isPlaying) lastRafTime.current = null
  }

  function handlePlayPause() {
    if (!pbData || duration === 0) return
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

  // Populate: create FleetChatShape + FleetAgentsShape as children if not already present
  function handlePopulate() {
    const children = editor.getCurrentPageShapes().filter(
      (s: any) => s.parentId === shape.id
    )
    const hasChat = children.some((s: any) => s.type === 'fleet-chat')
    const hasAgents = children.some((s: any) => s.type === 'fleet-agents')

    if (!hasChat) {
      editor.createShape({
        type: 'fleet-chat',
        parentId: shape.id,
        x: 0,
        y: HEADER_H + SCRUBBER_H,
        props: { w, h: 600, filter: [] },
      })
    }
    if (!hasAgents) {
      editor.createShape({
        type: 'fleet-agents',
        parentId: shape.id,
        x: w + 8,
        y: HEADER_H + SCRUBBER_H,
        props: { w: 340, h: 400 },
      })
    }
  }

  const title = loading ? 'Loading…' : error ? `Error: ${error}` : (pbData?.title ?? 'Set playbackId in props')

  return (
    <HTMLContainer
      id={shape.id}
      style={{ width: w, height: h, pointerEvents: 'all', overflow: 'visible' }}
    >
      <div
        className="pbf-root"
        onPointerDown={stopEventPropagation}
        onPointerMove={stopEventPropagation}
        onWheel={stopEventPropagation}
        style={{ width: w }}
      >
        {/* Header */}
        <div className="pbf-header" style={{ height: HEADER_H }}>
          <span className="pbf-title">{title}</span>
          {pbData && (
            <span className="pbf-meta">
              {new Date(pbData.created).toLocaleDateString()} · {formatDuration(duration)}
              {mode === 'curated' && <span className="pbf-mode-badge">curated</span>}
            </span>
          )}
          {pbData && (
            <button
              className="pbf-btn pbf-populate"
              onClick={handlePopulate}
              title="Add chat + agents shapes inside this frame"
            >＋HUD</button>
          )}
        </div>

        {/* Scrubber */}
        <div className="pbf-scrubber" style={{ height: SCRUBBER_H }}>
          <div className="pbf-scrubber-controls">
            <button
              className="pbf-btn"
              onClick={handleRewind}
              title="Rewind"
              disabled={!pbData || duration === 0}
            >⏮</button>
            <button
              className="pbf-btn pbf-play"
              onClick={handlePlayPause}
              disabled={!pbData || duration === 0}
            >
              {isPlaying ? '⏸' : '▶'}
            </button>
            <input
              className="pbf-speed"
              type="text"
              value={speedText}
              title="Playback speed (e.g. 0.5, 2, 10)"
              onChange={e => setSpeedText(e.target.value)}
              onFocus={e => { setSpeedText(String(playSpeed)); e.target.select() }}
              onBlur={() => {
                const v = parseFloat(speedText)
                if (!isNaN(v) && v > 0) { setPlaySpeed(v); setSpeedText(String(v)) }
                else setSpeedText(String(playSpeed))
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
            />
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
            disabled={!pbData || duration === 0}
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
      h: HEADER_H + SCRUBBER_H,
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
    return <rect width={shape.props.w} height={shape.props.h} rx={4} />
  }
}
