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
  Vec,
  stopEventPropagation,
  useEditor,
} from 'tldraw'
import { useState, useEffect, useRef, useCallback } from 'react'
import {
  updatePlayback,
  unregisterPlayback,
  getLayoutKeyframe,
  getEffectiveSpeed,
  extractTimewarps,
  extractSubs,
  getCurrentSubtitle,
  type PlaybackData,
  type Timewarp,
  type SubtitleEntry,
  type TimewarpRegion,
} from '../playback-context'
import './PlaybackFrameShape.css'

const FLEET_API = 'http://localhost:5199'
const DEFAULT_W = 500
const SCRUBBER_H = 64
const HEADER_H = 36
const CHROME_H = HEADER_H + SCRUBBER_H   // 100px
const DEFAULT_H = CHROME_H + 640         // generous content area below chrome

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

// --- Speed graph ---

/**
 * SVG line graph showing speed profile over the recording duration.
 * Rendered as an overlay on top of the range slider.
 * X = time (0..duration), Y = speed (1x..maxSpeed).
 * Jump regions (>100x) shown as near-vertical spikes.
 */
function SpeedGraph({ regions, duration }: { regions: TimewarpRegion[]; duration: number }) {
  const H = 22
  const GRAPH_H = 16  // drawing area above baseline

  if (!duration || duration === 0) return null

  // Build a flat 1x region if no regions provided
  const allRegions: TimewarpRegion[] = regions.length > 0
    ? regions
    : [{ start_ms: 0, end_ms: duration, speed: 1 }]

  const maxSpeed = Math.max(...allRegions.map(r => Math.min(r.speed, 200)), 1)

  // Convert region to SVG points
  const pts: string[] = []
  const toX = (ms: number) => (ms / duration) * 100  // percent
  const toY = (speed: number) => {
    // Clamp jump regions (>100x) to near top, others log-scaled
    const clamped = Math.min(speed, maxSpeed)
    return H - (clamped / maxSpeed) * GRAPH_H
  }

  // Start at baseline
  pts.push(`0,${H}`)
  for (const r of allRegions) {
    const x1 = toX(r.start_ms)
    const x2 = toX(r.end_ms)
    const y = toY(r.speed)
    pts.push(`${x1}%,${y}`)
    pts.push(`${x2}%,${y}`)
  }
  pts.push(`100%,${H}`)
  pts.push(`0,${H}`)

  return (
    <svg
      className="pbf-speed-graph"
      viewBox={`0 0 100 ${H}`}
      preserveAspectRatio="none"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: 0,
        width: '100%',
        height: H,
        pointerEvents: 'none',
      }}
    >
      <polyline
        points={pts.join(' ')}
        fill="rgba(99,179,237,0.15)"
        stroke="rgba(99,179,237,0.6)"
        strokeWidth="0.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

// --- Component ---

function PlaybackFrameComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const { playbackId, mode, w, h } = shape.props

  const [pbData, setPbData] = useState<PlaybackData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Recording picker — fetched when no playbackId set
  const [recordings, setRecordings] = useState<any[] | null>(null)
  const [recLoading, setRecLoading] = useState(false)

  useEffect(() => {
    if (playbackId) return
    setRecLoading(true)
    fetch(`${FLEET_API}/api/playbacks`)
      .then(r => r.ok ? r.json() : [])
      .then(data => { setRecordings(Array.isArray(data) ? data : (data.playbacks ?? [])); setRecLoading(false) })
      .catch(() => { setRecordings([]); setRecLoading(false) })
  }, [playbackId])

  // Scrubber state (local — not synced to Yjs)
  const [currentMs, setCurrentMs] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [playSpeed, setPlaySpeed] = useState(1)
  const [speedText, setSpeedText] = useState('1x')

  // Timewarp state (named cuts from recording edits)
  const [timewarps, setTimewarps] = useState<Timewarp[]>([])
  const [activeTimewarp, setActiveTimewarp] = useState<Timewarp | null>(null)

  // Subtitle state
  const [subs, setSubs] = useState<SubtitleEntry[]>([])

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

        // Extract named cuts (timewarps) from edits
        const tws = extractTimewarps(data.edits || [], data.duration_ms)
        const autoTw = tws.find((t: Timewarp) => t.name === 'edits') ?? tws[0] ?? null
        setTimewarps(tws)
        setActiveTimewarp(autoTw)

        // Extract subtitles
        setSubs(extractSubs(data.edits || []))

        const pb: PlaybackData = {
          events: data.events || [],
          agents: agentIds.map((id: string) => ({
            id,
            friendly_name: undefined,
          })),
          currentMs: 0,
          duration_ms: data.duration_ms || 0,
          title: data.title || 'Untitled',
          created: data.created || new Date().toISOString(),
          timewarps: tws,
          activeTimewarp: autoTw,
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

  // Update registry whenever currentMs or activeTimewarp changes
  useEffect(() => {
    if (!pbData) return
    const updated = { ...pbData, currentMs, activeTimewarp }
    updatePlayback(shape.id, updated)
  }, [currentMs, activeTimewarp, pbData, shape.id])

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
    const wallDelta = now - lastRafTime.current
    lastRafTime.current = now

    setCurrentMs(prev => {
      if (!pbData) return prev
      const effSpeed = getEffectiveSpeed(activeTimewarp, prev, playSpeed)
      let next: number
      // Jump regions (>100x): snap to region end instantly
      if (effSpeed > 100 && activeTimewarp) {
        const region = activeTimewarp.regions.find(r => prev >= r.start_ms && prev < r.end_ms)
        next = region ? Math.min(region.end_ms, pbData.duration_ms) : Math.min(prev + wallDelta * effSpeed, pbData.duration_ms)
      } else {
        next = Math.min(prev + wallDelta * effSpeed, pbData.duration_ms)
      }
      if (next >= pbData.duration_ms) {
        setIsPlaying(false)
        return pbData.duration_ms
      }
      return next
    })
    rafRef.current = requestAnimationFrame(tick)
  }, [playSpeed, activeTimewarp, pbData])

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

    // Layout: chat 60%, agents 40%, both inside frame bounds
    const chatW = Math.floor(w * 0.6)
    const agentsW = w - chatW - 4
    const contentY = CHROME_H  // below header + scrubber

    if (!hasChat) {
      editor.createShape({
        type: 'fleet-chat' as any,
        parentId: shape.id,
        x: 0,
        y: contentY,
        props: { w: chatW, h: h - contentY, filter: [] },
      })
    }
    if (!hasAgents) {
      editor.createShape({
        type: 'fleet-agents' as any,
        parentId: shape.id,
        x: chatW + 4,
        y: contentY,
        props: { w: agentsW, h: h - contentY },
      })
    }
  }

  const hasChildren = editor.getSortedChildIdsForParent(shape.id).length > 0
  const contentH = h - CHROME_H

  const title = loading ? 'Loading…' : error ? `Error: ${error}` : (pbData?.title ?? '')

  // Recording picker — shown when no playbackId set
  if (!playbackId) {
    return (
      <HTMLContainer
        id={shape.id}
        style={{ width: w, height: h, pointerEvents: 'none', overflow: 'visible' }}
      >
        <div
          className="pbf-picker"
          onPointerDown={stopEventPropagation}
          onPointerMove={stopEventPropagation}
          onWheel={stopEventPropagation}
          style={{ width: w, height: h, pointerEvents: 'all' }}
        >
          <div className="pbf-picker-header">📼 Choose a recording</div>
          {recLoading && <div className="pbf-picker-empty">Loading…</div>}
          {!recLoading && recordings?.length === 0 && (
            <div className="pbf-picker-empty">No recordings found</div>
          )}
          {!recLoading && recordings && recordings.length > 0 && (
            <div className="pbf-picker-list">
              {recordings.map((rec: any) => (
                <button
                  key={rec.id}
                  className="pbf-picker-item"
                  onClick={() => editor.updateShape({ id: shape.id, type: 'playback-frame' as any, props: { playbackId: rec.id } })}
                >
                  <span className="pbf-picker-name">{rec.title || rec.id}</span>
                  <span className="pbf-picker-meta">
                    {rec.created ? new Date(rec.created).toLocaleDateString() : ''}
                    {rec.duration_ms ? ` · ${Math.round(rec.duration_ms / 60000)}m` : ''}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </HTMLContainer>
    )
  }

  return (
    <HTMLContainer
      id={shape.id}
      style={{ width: w, height: h, pointerEvents: 'none', overflow: 'visible' }}
    >
      <div
        className="pbf-root"
        onWheel={stopEventPropagation}
        style={{ width: w, pointerEvents: 'none' }}
      >
        {/* Header — pointer-events none so tldraw can detect drag from title area */}
        <div className="pbf-header" style={{ height: HEADER_H, pointerEvents: 'none' }}>
          <span className="pbf-title">{title}</span>
          {pbData && (
            <span className="pbf-meta">
              {new Date(pbData.created).toLocaleDateString()} · {formatDuration(duration)}
              {mode === 'curated' && <span className="pbf-mode-badge">curated</span>}
            </span>
          )}
          {pbData && timewarps.length > 0 && (
            <select
              className="pbf-cut-select"
              value={activeTimewarp?.name ?? '__none__'}
              onChange={e => {
                const tw = timewarps.find(t => t.name === e.target.value) ?? null
                setActiveTimewarp(tw)
              }}
              onPointerDown={stopEventPropagation}
              style={{ pointerEvents: 'all' }}
              title="Playback cut (timewarp)"
            >
              <option value="__none__">raw</option>
              {timewarps.map(tw => (
                <option key={tw.name} value={tw.name}>{tw.name}</option>
              ))}
            </select>
          )}
          {pbData && (
            <button
              className="pbf-btn pbf-populate"
              onClick={handlePopulate}
              onPointerDown={stopEventPropagation}
              style={{ pointerEvents: 'all' }}
              title="Add chat + agents shapes inside this frame"
            >＋HUD</button>
          )}
        </div>

        {/* Scrubber — fully interactive, captures all pointer events */}
        <div
          className="pbf-scrubber"
          onPointerDown={stopEventPropagation}
          onPointerMove={stopEventPropagation}
          onWheel={stopEventPropagation}
          style={{ height: SCRUBBER_H, pointerEvents: 'all' }}
        >
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
                if (!isNaN(v) && v > 0) { setPlaySpeed(v); setSpeedText(`${v}x`) }
                else setSpeedText(`${playSpeed}x`)
              }}
              onKeyDown={e => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
            />
            <span className="pbf-time">
              {formatDuration(currentMs)} / {formatDuration(duration)}
            </span>
          </div>
          <div className="pbf-timeline-wrap" style={{ position: 'relative' }}>
            <SpeedGraph
              regions={activeTimewarp?.regions ?? []}
              duration={duration}
            />
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
      </div>

      {/* Subtitle overlay — timed narrative text at bottom of frame */}
      {(() => {
        const sub = subs.length > 0 ? getCurrentSubtitle(subs, currentMs) : null
        return sub ? (
          <div className="pbf-subtitle" style={{
            position: 'absolute',
            bottom: 8,
            left: 8,
            right: 8,
            pointerEvents: 'none',
          }}>
            {sub}
          </div>
        ) : null
      })()}

      {/* Content area — drop zone below chrome, visual only */}
      {!hasChildren && (
        <div
          className="pbf-drop-zone"
          style={{ width: w, height: contentH }}
        />
      )}
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

  // Clip children to the frame bounds — returns polygon corners in local coords
  override getClipPath(shape: any) {
    const { w, h } = shape.props
    return [
      new Vec(0, 0),
      new Vec(w, 0),
      new Vec(w, h),
      new Vec(0, h),
    ]
  }

  // Scale-to-fit: when the frame is resized, scale all child shapes proportionally.
  // Children y-positions are measured from CHROME_H (the content start), so the
  // chrome area stays fixed and only the content area scales.
  override onResize(shape: any, info: any) {
    const { editor } = this
    const { scaleX, scaleY } = info
    const children = editor.getSortedChildIdsForParent(shape.id)
      .map((id: any) => editor.getShape(id))
      .filter(Boolean)

    if (children.length > 0) {
      editor.updateShapes(children.map((child: any) => ({
        id: child.id,
        type: child.type,
        x: child.x * scaleX,
        y: CHROME_H + (child.y - CHROME_H) * scaleY,
        props: {
          ...child.props,
          w: Math.max(10, child.props.w * Math.abs(scaleX)),
          h: Math.max(10, child.props.h * Math.abs(scaleY)),
        },
      })))
    }

    return super.onResize(shape, info)
  }

  // Allow shapes to be dragged into this frame (reparenting)
  override onDragShapesIn(shape: any, draggingShapes: any[], _info: any) {
    const { editor } = this
    if (draggingShapes.every((s: any) => s.parentId === shape.id)) return
    if (draggingShapes.some((s: any) => editor.hasAncestor(shape, s.id))) return
    editor.reparentShapes(draggingShapes, shape.id)
  }

  override onDragShapesOut(shape: any, draggingShapes: any[], info: any) {
    const { editor } = this
    if (!info.nextDraggingOverShapeId) {
      editor.reparentShapes(
        draggingShapes.filter((s: any) => s.parentId === shape.id),
        editor.getCurrentPageId()
      )
    }
  }

  component(shape: any) {
    return <PlaybackFrameComponent shape={shape} />
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} rx={4} />
  }
}
