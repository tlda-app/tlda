/**
 * FleetIconPill — small fleet icon in the build-pills-row.
 * Same visual weight as BuildWarningPill.
 *
 * Click  → toggle fleet shapes visible/hidden on the main canvas
 * Drag   → fan out horizontal strip of layout preset options; release to apply
 */
import { useState, useCallback, useRef, useEffect } from 'react'
import type { Editor } from 'tldraw'
import { useFleetAgents } from '../fleet-data-adapter'
import { createFleetLayout } from '../shapes/fleet-utils'
import './FleetIconPill.css'

const DRAG_THRESHOLD = 6 // px before drag mode activates

const LAYOUT_PRESETS = [
  { id: '3col' as const, label: '3-col', title: 'Three-column layout: agents + search | chat | chat + docview' },
  { id: '2col' as const, label: '2-col', title: 'Two-column layout: agents + search + chat | right chat' },
]

/** Body class used to hide fleet shapes on the main canvas (same pattern as fleet-hud-open). */
export const FLEET_HIDDEN_CLASS = 'fleet-shapes-hidden'

/** Read current visibility state from DOM. */
export function isFleetHidden(): boolean {
  return document.body.classList.contains(FLEET_HIDDEN_CLASS)
}

/** Toggle fleet shapes hidden/visible without editor invalidation. CSS handles it. */
export function setFleetHidden(hidden: boolean) {
  document.body.classList.toggle(FLEET_HIDDEN_CLASS, hidden)
}

// ── Small grid SVG icon ─────────────────────────────────────────────────────

function FleetGridIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <rect x="1" y="1" width="4" height="4" rx="0.5"/>
      <rect x="7" y="1" width="4" height="4" rx="0.5"/>
      <rect x="1" y="7" width="4" height="4" rx="0.5"/>
      <rect x="7" y="7" width="4" height="4" rx="0.5"/>
    </svg>
  )
}

// ── FleetIconPill ────────────────────────────────────────────────────────────

interface FleetIconPillProps {
  mainEditor: Editor
}

export function FleetIconPill({ mainEditor }: FleetIconPillProps) {
  const agents = useFleetAgents()
  const [hidden, setHiddenState] = useState(() => isFleetHidden())
  const [dragging, setDragging] = useState(false)
  const [hoveredPreset, setHoveredPreset] = useState<string | null>(null)
  const pillRef = useRef<HTMLDivElement>(null)
  const fanRef = useRef<HTMLDivElement>(null)
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null)
  const isDragRef = useRef(false)

  const aliveCount = agents.filter((a: any) => !a.dead && !a.human).length

  // Sync hidden state when body class changes externally
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setHiddenState(isFleetHidden())
    })
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])

  // Detect which preset the pointer is over during drag
  const updateHoveredPreset = useCallback((clientX: number, clientY: number) => {
    if (!fanRef.current) return
    const items = fanRef.current.querySelectorAll<HTMLElement>('[data-preset-id]')
    let found: string | null = null
    for (const item of items) {
      const r = item.getBoundingClientRect()
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
        found = item.dataset.presetId ?? null
        break
      }
    }
    setHoveredPreset(found)
  }, [])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation()
    pointerStartRef.current = { x: e.clientX, y: e.clientY }
    isDragRef.current = false
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!pointerStartRef.current) return
    const dx = e.clientX - pointerStartRef.current.x
    const dy = e.clientY - pointerStartRef.current.y
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (dist > DRAG_THRESHOLD) {
      if (!isDragRef.current) {
        isDragRef.current = true
        setDragging(true)
      }
    }
    if (isDragRef.current) {
      updateHoveredPreset(e.clientX, e.clientY)
    }
  }, [updateHoveredPreset])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    e.stopPropagation()
    const wasDrag = isDragRef.current

    if (wasDrag && hoveredPreset) {
      // Apply layout preset
      const preset = LAYOUT_PRESETS.find(p => p.id === hoveredPreset)
      if (preset) {
        createFleetLayout(mainEditor, agents, preset.id)
      }
    } else if (!wasDrag) {
      // Toggle visibility
      const next = !isFleetHidden()
      setFleetHidden(next)
      setHiddenState(next)
    }

    // Reset drag state
    pointerStartRef.current = null
    isDragRef.current = false
    setDragging(false)
    setHoveredPreset(null)
  }, [hoveredPreset, mainEditor, agents])

  const handlePointerCancel = useCallback(() => {
    pointerStartRef.current = null
    isDragRef.current = false
    setDragging(false)
    setHoveredPreset(null)
  }, [])

  return (
    <div
      ref={pillRef}
      className={'fleet-icon-pill-container' + (hidden ? ' fleet-icon-pill--hidden' : '')}
    >
      <div
        className="fleet-icon-pill"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        title={hidden ? 'Fleet shapes hidden — click to show' : 'Fleet — click to hide, drag for layout'}
        role="button"
        aria-label={`Fleet: ${aliveCount} agent${aliveCount !== 1 ? 's' : ''}`}
      >
        <FleetGridIcon size={10} />
        {aliveCount > 0 && (
          <span className="fleet-icon-pill-count">{aliveCount}</span>
        )}
      </div>

      {dragging && (
        <div ref={fanRef} className="fleet-icon-pill-fan">
          {LAYOUT_PRESETS.map(preset => (
            <div
              key={preset.id}
              data-preset-id={preset.id}
              className={'fleet-icon-pill-fan-item' + (hoveredPreset === preset.id ? ' hovered' : '')}
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
