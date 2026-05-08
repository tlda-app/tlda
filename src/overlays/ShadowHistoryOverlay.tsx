/**
 * ShadowHistoryOverlay — floating scrubber for navigating shadow repo history.
 *
 * Shows as a slim bar at the bottom of the canvas. The slider is a TIME AXIS
 * spanning from the oldest build to now. Dragging to a position queries the
 * server for the nearest real build at that timestamp. Step buttons move to
 * the actual adjacent build (one save at a time), so any historical version
 * is reachable even in projects with hundreds of thousands of builds.
 *
 * Pointer events are handled by BrowseIdle.markEventAsHandled, which prevents
 * TLDraw from calling setPointerCapture on the canvas and stealing the drag.
 */

import { useCallback, useRef, useState, useMemo } from 'react'
import type { ShadowVersion, ShadowTimeBounds } from '../historyStore'
import './ShadowHistoryOverlay.css'

const SLIDER_STEPS = 1000  // resolution of the time-axis slider

// Event types and colors (matches TimelineOverlayShape)
const EVENT_COLORS: Record<string, string> = {
  build: '#f59e0b',       // amber — builds
  annotation: '#6366f1',  // indigo — annotations
  highlight: '#10b981',   // emerald — highlights
  comment: '#8b5cf6',     // violet — comments/notes
}

export interface TimelineDot {
  timestamp: number
  type: 'build' | 'annotation' | 'highlight' | 'comment'
  label?: string
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = Date.now()
  const diffMs = now - ts
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 7) return `${diffDay}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// Map slider integer position (0=oldest, SLIDER_STEPS=current) to a timestamp
function sliderPosToTimestamp(pos: number, bounds: ShadowTimeBounds): number {
  if (pos >= SLIDER_STEPS) return Date.now()
  const t = pos / SLIDER_STEPS  // 0=oldest, 1≈newest
  return Math.round(bounds.oldest.timestamp + t * (bounds.newest.timestamp - bounds.oldest.timestamp))
}

// Map an active version's timestamp back to a slider position
function timestampToSliderPos(ts: number, bounds: ShadowTimeBounds): number {
  const span = bounds.newest.timestamp - bounds.oldest.timestamp
  if (span === 0) return 0
  const t = (ts - bounds.oldest.timestamp) / span
  return Math.round(Math.max(0, Math.min(SLIDER_STEPS - 1, t * SLIDER_STEPS)))
}

interface Props {
  timeBounds: ShadowTimeBounds
  /** Currently displayed version. null = current (no shadow column). */
  activeVersion: ShadowVersion | null
  loading: boolean
  onScrubTime: (timestamp: number) => void
  onStep: (dir: 'older' | 'newer') => void
  onClose: () => void
  onRealign?: () => void
  /** Timeline event dots to render along the slider track */
  timelineDots?: TimelineDot[]
}

export function ShadowHistoryOverlay({ timeBounds, activeVersion, loading, onScrubTime, onStep, onClose, onRealign, timelineDots }: Props) {
  const resolvedSliderVal = activeVersion
    ? timestampToSliderPos(activeVersion.timestamp, timeBounds)
    : SLIDER_STEPS  // rightmost = current

  // Optimistic local position: tracks the drag position immediately so the
  // slider doesn't snap back while waiting for the server to resolve a version.
  // Reset to null when activeVersion changes (server resolved).
  const [localPos, setLocalPos] = useState<number | null>(null)
  const sliderVal = localPos ?? resolvedSliderVal

  // When the server resolves a new version, clear the local optimistic position
  const prevHashRef = useRef<string | null>(null)
  const activeHash = activeVersion?.hash ?? null
  if (activeHash !== prevHashRef.current) {
    prevHashRef.current = activeHash
    if (localPos !== null) setLocalPos(null)
  }

  const lastScrubRef = useRef<number>(0)
  const handleRange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const pos = parseInt(e.target.value, 10)
    const now = Date.now()
    // Update local position immediately for smooth dragging
    setLocalPos(Math.min(pos, SLIDER_STEPS - 1))
    if (now - lastScrubRef.current < 50) return  // 50ms throttle for server calls
    lastScrubRef.current = now
    const clamped = Math.min(pos, SLIDER_STEPS - 1)
    onScrubTime(sliderPosToTimestamp(clamped, timeBounds))
  }, [onScrubTime, timeBounds])

  const isCurrent = activeVersion === null
  const isAtOldest = activeVersion?.hash === timeBounds.oldest.hash

  // Compute dot positions as percentages along the slider track
  const dotPositions = useMemo(() => {
    if (!timelineDots || timelineDots.length === 0) return []
    const span = timeBounds.newest.timestamp - timeBounds.oldest.timestamp
    if (span === 0) return []
    return timelineDots.map(dot => ({
      pct: Math.max(0, Math.min(100, ((dot.timestamp - timeBounds.oldest.timestamp) / span) * 100)),
      color: EVENT_COLORS[dot.type] || EVENT_COLORS.build,
      label: dot.label,
      type: dot.type,
    }))
  }, [timelineDots, timeBounds])

  // All hooks above — hide via CSS instead of returning null (keeps hooks stable)
  const isHidden = isCurrent

  let labelText: React.ReactNode
  if (loading) {
    labelText = <span className="shadow-scrubber-loading">Loading…</span>
  } else if (isCurrent) {
    labelText = <span className="shadow-current-badge">Current</span>
  } else if (activeVersion) {
    const time = formatTime(activeVersion.timestamp)
    const shortHash = activeVersion.hash.slice(0, 7)
    labelText = (
      <>
        <span className="shadow-time">{time}</span>
        <span style={{ opacity: 0.45, marginLeft: 4, fontFamily: 'monospace', fontSize: 10 }}>{shortHash}</span>
      </>
    )
  }

  return (
    <div
      className={`shadow-scrubber${!isCurrent ? ' active' : ''}`}
      style={isHidden ? { display: 'none' } : undefined}
    >
      {/* Older — step to the build just before this one */}
      <button
        className="shadow-scrubber-step"
        disabled={isAtOldest}
        onClick={() => onStep('older')}
        title="Older (one build)"
      >‹</button>

      <div className="shadow-scrubber-track-wrap">
        {dotPositions.length > 0 && (
          <div className="shadow-scrubber-dots" aria-hidden="true">
            {dotPositions.map((d, i) => (
              <span
                key={i}
                className="shadow-scrubber-dot"
                style={{
                  left: `${d.pct}%`,
                  backgroundColor: d.color,
                }}
                title={d.label || d.type}
              />
            ))}
          </div>
        )}
        <input
          type="range"
          className="shadow-scrubber-range"
          min={0}
          max={SLIDER_STEPS}
          value={sliderVal}
          onChange={handleRange}
          title="Drag to scrub history by time — right = current, left = older"
        />
      </div>

      {/* Newer — step to the build just after, or back to current */}
      <button
        className="shadow-scrubber-step"
        disabled={isCurrent}
        onClick={() => onStep('newer')}
        title="Newer (one build)"
      >›</button>

      <span className="shadow-scrubber-label">{labelText}</span>

      {onRealign && !isCurrent && (
        <button
          className="shadow-scrubber-realign"
          onClick={onRealign}
          title="Re-align columns to viewport center"
        >⊙</button>
      )}

      <button className="shadow-scrubber-close" onClick={onClose} title="Close history">
        ×
      </button>
    </div>
  )
}
