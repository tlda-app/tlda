/**
 * FleetIconPill — basestar logo in the build-pills-row.
 *
 * Click  → toggle fleet shapes visible/hidden (body.fleet-shapes-hidden CSS class)
 * Drag   → horizontal preset fan; drag right to slide between 3-col / 2-col;
 *          release to apply. Items appear at fixed position near cursor — same
 *          pattern as HighlighterSlider (position computed by math, not elementFromPoint).
 *
 * Uses window-level pointermove/pointerup listeners to avoid pointer-capture
 * issues inside TLDraw's InFrontOfTheCanvas layer.
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
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)
  const isDragRef = useRef(false)
  const selectedIdxRef = useRef<number | null>(null)
  const agentsRef = useRef(agents)
  agentsRef.current = agents

  /** Compute which preset index is active for a given cursor X. */
  const getIdxFromX = useCallback((cursorX: number, startX: number): number => {
    // Items are displayed starting at startX.
    // Item i occupies [startX + i*(ITEM_W+ITEM_GAP), startX + i*(ITEM_W+ITEM_GAP) + ITEM_W]
    const step = ITEM_W + ITEM_GAP
    const rel = cursorX - startX
    const idx = Math.max(0, Math.min(LAYOUT_PRESETS.length - 1, Math.floor(rel / step)))
    return idx
  }, [])

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
        const idx = Math.max(0, Math.min(LAYOUT_PRESETS.length - 1, Math.floor((ev.clientX - s.x) / (ITEM_W + ITEM_GAP))))
        // If cursor is left of start, keep idx 0
        const safeIdx = ev.clientX < s.x ? 0 : idx
        selectedIdxRef.current = safeIdx
        setSelectedIdx(safeIdx)
      }
    }

    const onUp = (_ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)

      if (isDragRef.current) {
        const idx = selectedIdxRef.current
        if (idx !== null) {
          const preset = LAYOUT_PRESETS[idx]
          createFleetLayout(mainEditor, agentsRef.current, preset.id)
        }
      } else {
        // Click: toggle visibility
        const next = !isFleetHidden()
        document.body.classList.toggle(FLEET_HIDDEN_CLASS, next)
        setHidden(next)
      }

      isDragRef.current = false
      dragStartRef.current = null
      selectedIdxRef.current = null
      setDragging(false)
      setSelectedIdx(null)
      setDragAnchor(null)
    }

    const onCancel = () => {
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

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
  }, [mainEditor, getIdxFromX])

  return (
    <div
      className={'fleet-icon-pill-container' + (hidden ? ' fleet-icon-pill--hidden' : '')}
      onPointerDown={handlePointerDown}
      title={hidden ? 'Fleet shapes hidden — click to show' : 'Fleet — click to hide, drag for layout'}
      role="button"
      aria-label={`Fleet: ${aliveCount} agent${aliveCount !== 1 ? 's' : ''}`}
      style={{ touchAction: 'none' }}
    >
      <img src="/basestar.svg" width={10} height={10} alt="" className="fleet-icon-pill-logo" />
      {aliveCount > 0 && (
        <span className="fleet-icon-pill-count">{aliveCount}</span>
      )}

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
