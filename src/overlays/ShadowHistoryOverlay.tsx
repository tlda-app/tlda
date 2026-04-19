/**
 * ShadowHistoryOverlay — floating scrubber for navigating shadow repo history.
 *
 * Shows as a slim bar at the bottom of the canvas. When the user scrubs to a
 * historical position, old SVG pages appear to the left of the current pages.
 *
 * Activates via a "History" button in the document panel, or by calling
 * toggleShadowOverlay() from the parent.
 */

import { useCallback, useState, useEffect } from 'react'
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
  const [side, setSide] = useState<'left' | 'right'>(() =>
    (localStorage.getItem('tlda-shadow-side') as 'left' | 'right') || 'left'
  )
  const sliderMax = versions.length
  const sliderVal = activeIdx < 0 ? 0 : activeIdx + 1

  const handleRange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseInt(e.target.value, 10)
    onScrub(v <= 0 ? -1 : v - 1)
  }, [onScrub])

  const step = useCallback((dir: number) => {
    // dir=-1 = newer (toward current), dir=+1 = older (away from current)
    const newSlider = Math.max(0, Math.min(sliderMax, sliderVal + dir))
    onScrub(newSlider <= 0 ? -1 : newSlider - 1)
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
      onPointerDown={e => e.stopPropagation()}
      onPointerUp={e => e.stopPropagation()}
    >
      {/* Older */}
      <button
        className="shadow-scrubber-step"
        disabled={sliderVal >= sliderMax}
        onClick={() => step(1)}
        title="Older"
      >‹</button>

      <input
        type="range"
        className="shadow-scrubber-range"
        min={0}
        max={sliderMax}
        value={sliderVal}
        onChange={handleRange}
        title="Drag to scrub history"
      />

      {/* Newer */}
      <button
        className="shadow-scrubber-step"
        disabled={sliderVal <= 0}
        onClick={() => step(-1)}
        title="Newer"
      >›</button>

      <span className="shadow-scrubber-pos">{pos}</span>
      <span className="shadow-scrubber-label">{labelText}</span>

      <button
        className="shadow-scrubber-side"
        onClick={() => {
          const next = side === 'left' ? 'right' : 'left'
          setSide(next)
          localStorage.setItem('tlda-shadow-side', next)
          // Re-scrub to reposition shapes
          if (activeIdx >= 0) onScrub(activeIdx)
        }}
        title={`Old version on ${side} — click to switch`}
      >{side === 'left' ? '◁' : '▷'}</button>
      <button className="shadow-scrubber-close" onClick={onClose} title="Close history">
        ×
      </button>
    </div>
  )
}
