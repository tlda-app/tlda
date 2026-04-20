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

interface Props {
  versions: ShadowVersion[]
  /** Index into versions (0 = newest). -1 means current. */
  activeIdx: number
  loading: boolean
  onScrub: (idx: number) => void
  onClose: () => void
}

export function ShadowHistoryOverlay({ versions, activeIdx, loading, onScrub, onClose }: Props) {
  const sliderMax = versions.length
  // Slider: right edge (sliderMax) = current, left edge (0) = oldest.
  const sliderVal = activeIdx < 0 ? sliderMax : sliderMax - 1 - activeIdx

  const handleRange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseInt(e.target.value, 10)
    // v = sliderMax → current (-1); v < sliderMax → versions[sliderMax - 1 - v]
    onScrub(v >= sliderMax ? -1 : sliderMax - 1 - v)
  }, [onScrub, sliderMax])

  const step = useCallback((dir: number) => {
    // dir=-1 = older (left), dir=+1 = newer (right, toward current)
    const newSlider = Math.max(0, Math.min(sliderMax, sliderVal + dir))
    onScrub(newSlider >= sliderMax ? -1 : sliderMax - 1 - newSlider)
  }, [sliderVal, sliderMax, onScrub])

  // All hooks above — hide via CSS instead of returning null (keeps hooks stable)
  const isHidden = versions.length < 2 || activeIdx < 0

  const isCurrent = activeIdx < 0
  const activeVersion = activeIdx >= 0 && activeIdx < versions.length ? versions[activeIdx] : null

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

  const pos = isCurrent ? 'now' : `${activeIdx + 1}/${versions.length}`

  return (
    <div
      className={`shadow-scrubber${!isCurrent ? ' active' : ''}`}
      style={isHidden ? { display: 'none' } : undefined}
    >
      {/* Older — moves left (decreases sliderVal) */}
      <button
        className="shadow-scrubber-step"
        disabled={sliderVal <= 0}
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
        title="Drag to scrub history — right = current, left = older"
      />

      {/* Newer — moves right (increases sliderVal, toward current) */}
      <button
        className="shadow-scrubber-step"
        disabled={sliderVal >= sliderMax}
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
