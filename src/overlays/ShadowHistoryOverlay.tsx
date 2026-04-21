/**
 * ShadowHistoryOverlay — floating scrubber for navigating shadow repo history.
 *
 * Shows as a slim bar at the bottom of the canvas. When the user scrubs to a
 * historical position, old SVG pages appear to the right of the current pages.
 *
 * Activates via a "History" button in the document panel, or by calling
 * toggleShadowOverlay() from the parent.
 *
 * Slider direction: current version is on the RIGHT edge (sliderMax), oldest
 * is on the LEFT edge (0). Dragging right = toward current; dragging left =
 * into history. Dragging all the way to the right dismisses the overlay.
 *
 * Scale: sqrt mapping so recent versions occupy more of the slider range.
 * Slider pos → version idx: idx = (N-1) * (1 - pos/(N-1))^2
 * Version idx → slider pos: pos = (N-1) * (1 - sqrt(idx/(N-1)))
 * Step buttons always move exactly 1 version, independent of scale.
 *
 * Pointer events are handled by BrowseIdle.markEventAsHandled, which prevents
 * TLDraw from calling setPointerCapture on the canvas and stealing the drag.
 * No stopEventPropagation needed here.
 */

import { useCallback } from 'react'
import type { ShadowVersion } from '../historyStore'
import './ShadowHistoryOverlay.css'

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

// sqrt-scale helpers
// Slider positions: 0 (oldest) to N-1 (newest historical) to N (current).
// More slider resolution near "now" (right side).

function sqrtIdxFromPos(pos: number, N: number): number {
  if (pos >= N) return -1  // current
  if (N <= 1) return 0
  const t = pos / (N - 1)  // 0=oldest, 1=newest
  const idx = Math.round((N - 1) * (1 - t) * (1 - t))
  return Math.max(0, Math.min(N - 1, idx))
}

function sqrtPosFromIdx(idx: number, N: number): number {
  if (idx < 0) return N  // current
  if (N <= 1) return 0
  const u = idx / (N - 1)  // 0=newest, 1=oldest
  const t = 1 - Math.sqrt(u)  // 0=oldest direction, 1=newest direction
  return Math.round((N - 1) * t)
}

interface Props {
  versions: ShadowVersion[]
  /** Index into versions (0 = newest). -1 means current. */
  activeIdx: number
  loading: boolean
  onScrub: (idx: number) => void
  onClose: () => void
}

export function ShadowHistoryOverlay({ versions, activeIdx, loading, onScrub, onClose }: Props) {
  const N = versions.length
  const sliderMax = N
  const sliderVal = sqrtPosFromIdx(activeIdx, N)

  const handleRange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const pos = parseInt(e.target.value, 10)
    onScrub(sqrtIdxFromPos(pos, N))
  }, [onScrub, N])

  const step = useCallback((dir: number) => {
    // dir=+1 = newer (right, toward current), dir=-1 = older (left)
    if (dir > 0) {
      // newer: decrease idx
      if (activeIdx <= 0) onScrub(-1)
      else onScrub(activeIdx - 1)
    } else {
      // older: increase idx
      const newIdx = activeIdx < 0 ? 0 : Math.min(activeIdx + 1, N - 1)
      onScrub(newIdx)
    }
  }, [activeIdx, N, onScrub])

  // All hooks above — hide via CSS instead of returning null (keeps hooks stable)
  const isHidden = N < 2 || activeIdx < 0

  const isCurrent = activeIdx < 0
  const activeVersion = activeIdx >= 0 && activeIdx < N ? versions[activeIdx] : null

  let labelText: React.ReactNode
  if (loading) {
    labelText = <span className="shadow-scrubber-loading">Loading…</span>
  } else if (isCurrent) {
    labelText = <span className="shadow-current-badge">Current</span>
  } else if (activeVersion) {
    const time = formatTime(activeVersion.timestamp)
    // Show short hash alongside relative time — commit messages are always "Build at <ISO>"
    const shortHash = activeVersion.hash.slice(0, 7)
    labelText = (
      <>
        <span className="shadow-time">{time}</span>
        <span style={{ opacity: 0.45, marginLeft: 4, fontFamily: 'monospace', fontSize: 10 }}>{shortHash}</span>
      </>
    )
  }

  const pos = isCurrent ? 'now' : `${activeIdx + 1}/${N}`

  return (
    <div
      className={`shadow-scrubber${!isCurrent ? ' active' : ''}`}
      style={isHidden ? { display: 'none' } : undefined}
    >
      {/* Older — moves left (increases activeIdx toward oldest) */}
      <button
        className="shadow-scrubber-step"
        disabled={activeIdx >= N - 1}
        onClick={() => step(-1)}
        title="Older"
      >‹</button>

      <input
        type="range"
        className="shadow-scrubber-range"
        min={0}
        max={sliderMax}
        value={sliderVal}
        onChange={handleRange}
        title="Drag to scrub history — right = current, left = older (sqrt scale)"
      />

      {/* Newer — moves right (decreases activeIdx toward newest) */}
      <button
        className="shadow-scrubber-step"
        disabled={activeIdx < 0}
        onClick={() => step(1)}
        title="Newer"
      >›</button>

      <span className="shadow-scrubber-pos">{pos}</span>
      <span className="shadow-scrubber-label">{labelText}</span>

      <button className="shadow-scrubber-close" onClick={onClose} title="Close history">
        ×
      </button>
    </div>
  )
}
