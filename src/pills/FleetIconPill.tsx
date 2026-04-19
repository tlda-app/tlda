/**
 * FleetIconPill — basestar logo in the build-pills-row.
 *
 * Click  → toggle fleet shapes visible/hidden (body.fleet-shapes-hidden CSS class)
 * Drag   → horizontal preset fan; drag right to slide between 3-col / 2-col;
 *          release to apply.
 *
 * Matches BuildWarningPill's interaction pattern exactly:
 *   - onClick for click (with drag suppression via justDraggedRef)
 *   - onPointerDown={e => e.stopPropagation()} to prevent TLDraw from intercepting
 *   - Window-level pointermove/pointerup for drag tracking
 *
 * Inline SVG (fill="currentColor") so color-based opacity applies to icon + count together,
 * matching the single-color approach of .build-warning-badge.
 */
import { useState, useCallback, useRef } from 'react'
import type { Editor } from 'tldraw'
import { useFleetAgents } from '../fleet-data-adapter'
import { createFleetLayout } from '../shapes/fleet-utils'
import './FleetIconPill.css'

const DRAG_THRESHOLD = 6   // px before drag activates
const ITEM_W = 40          // px width of each preset tile
const ITEM_H = 22          // px height
const ITEM_GAP = 4         // px between tiles

const LAYOUT_PRESETS = [
  { id: '3col' as const, label: 'Fleet|',  title: 'Three-column: agents + search | chat | chat + docview' },
  { id: '2col' as const, label: 'Flee|t',  title: 'Two-column: left margin + right margin chat' },
]

/** Body class used to hide fleet shapes on the main canvas. */
const FLEET_HIDDEN_CLASS = 'fleet-shapes-hidden'

function isFleetHidden() { return document.body.classList.contains(FLEET_HIDDEN_CLASS) }

// ── FleetIconPill ────────────────────────────────────────────────────────────

interface FleetIconPillProps { mainEditor: Editor }

export function FleetIconPill({ mainEditor }: FleetIconPillProps) {
  const agents = useFleetAgents()
  const [hidden, setHidden] = useState(() => isFleetHidden())
  const [dragging, setDragging] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  const [dragAnchor, setDragAnchor] = useState<{ x: number; y: number } | null>(null)

  const aliveCount = agents.filter((a: any) => !a.dead && !a.human).length

  // Refs for closure-stable drag state (used inside window listeners)
  const justDraggedRef = useRef(false)
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)
  const isDragRef = useRef(false)
  const selectedIdxRef = useRef<number | null>(null)
  const agentsRef = useRef(agents)
  agentsRef.current = agents

  /** Click handler — toggle visibility (suppressed after a drag). */
  const handleClick = useCallback(() => {
    if (justDraggedRef.current) {
      justDraggedRef.current = false
      return
    }
    const next = !isFleetHidden()
    document.body.classList.toggle(FLEET_HIDDEN_CLASS, next)
    setHidden(next)
  }, [])

  /** Pointer down — stop propagation (prevents TLDraw interference) and set up drag listeners. */
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation()

    const start = { x: e.clientX, y: e.clientY }
    dragStartRef.current = start
    isDragRef.current = false
    selectedIdxRef.current = null

    const onMove = (ev: PointerEvent) => {
      const s = dragStartRef.current
      if (!s) return
      const dx = ev.clientX - s.x
      const dy = ev.clientY - s.y
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (!isDragRef.current && dist > DRAG_THRESHOLD) {
        isDragRef.current = true
        setDragging(true)
        setDragAnchor({ x: s.x, y: s.y })
      }
      if (isDragRef.current) {
        const idx = ev.clientX < s.x
          ? 0
          : Math.max(0, Math.min(LAYOUT_PRESETS.length - 1, Math.floor((ev.clientX - s.x) / (ITEM_W + ITEM_GAP))))
        selectedIdxRef.current = idx
        setSelectedIdx(idx)
      }
    }

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      isDragRef.current = false
      dragStartRef.current = null
      selectedIdxRef.current = null
      setDragging(false)
      setSelectedIdx(null)
      setDragAnchor(null)
    }

    const onUp = (_ev: PointerEvent) => {
      if (isDragRef.current) {
        const idx = selectedIdxRef.current
        if (idx !== null) {
          createFleetLayout(mainEditor, agentsRef.current, LAYOUT_PRESETS[idx].id)
        }
        justDraggedRef.current = true  // suppress the upcoming onClick
      }
      cleanup()
    }

    const onCancel = () => { cleanup() }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }, [mainEditor])

  return (
    <div
      className={'fleet-icon-pill-container' + (hidden ? ' fleet-icon-pill--hidden' : '')}
      title={hidden ? 'Fleet shapes hidden — click to show' : 'Fleet — click to hide, drag for layout'}
    >
      <span
        className="fleet-icon-pill-badge"
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        role="button"
        aria-label={`Fleet: ${aliveCount} agent${aliveCount !== 1 ? 's' : ''}`}
        style={{ touchAction: 'none' }}
      >
        {/* Inline basestar SVG — fill="currentColor" inherits span color for opacity control */}
        <svg viewBox="0 0 960 960" width={12} height={12} aria-hidden="true"
          style={{ display: 'block', fill: 'currentColor', flexShrink: 0 }}>
          <g transform="translate(0,960) scale(1,-1)">
            <path d="M130 865 c0 -15 45 -94 111 -197 60 -94 116 -183 124 -197 14 -28 34 -131 60 -306 23 -161 21 -155 55 -155 35 0 29 -21 69 238 17 106 38 206 46 222 8 16 64 105 125 199 116 179 132 221 84 221 -18 0 -63 -33 -162 -120 -84 -74 -145 -120 -159 -120 -23 0 -36 9 -194 147 -76 66 -115 93 -133 93 -21 0 -26 -5 -26 -25z"/>
            <path d="M467 883 c-3 -5 -11 -45 -18 -91 -11 -73 -11 -85 3 -99 11 -10 25 -13 42 -9 30 7 33 31 13 135 -11 59 -27 85 -40 64z"/>
            <path d="M268 260 c-43 -76 -78 -144 -78 -149 0 -29 43 -3 114 68 l78 79 -12 71 c-6 39 -15 71 -18 71 -4 0 -42 -63 -84 -140z"/>
            <path d="M591 337 c-6 -35 -11 -68 -11 -73 0 -16 180 -175 191 -169 5 4 9 13 9 21 0 17 -161 284 -171 284 -4 0 -12 -28 -18 -63z"/>
          </g>
        </svg>
        {aliveCount > 0 && aliveCount}
      </span>

      {/* Layout preset fan — fixed position at drag anchor */}
      {dragging && dragAnchor && (
        <div
          className="fleet-icon-pill-fan"
          style={{ left: dragAnchor.x, top: dragAnchor.y - ITEM_H / 2 }}
          onPointerDown={e => e.stopPropagation()}
        >
          {LAYOUT_PRESETS.map((preset, i) => (
            <div
              key={preset.id}
              className={'fleet-icon-pill-fan-item' + (selectedIdx === i ? ' hovered' : '')}
              style={{ width: ITEM_W, height: ITEM_H }}
              title={preset.title}
            >
              {preset.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
