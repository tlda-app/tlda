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
import React, { useState, useCallback, useRef } from 'react'
import type { Editor } from 'tldraw'
import { useFleetAgents } from '../fleet-data-adapter'
import { createFleetLayout } from '../shapes/fleet-utils'
import './FleetIconPill.css'

const DRAG_THRESHOLD = 6   // px before drag activates
const ITEM_W = 40          // px width of each preset tile
const ITEM_H = 22          // px height
const ITEM_GAP = 4         // px between tiles

type LayoutId = '3col' | '2col' | 'wide' | 'grid' | 'touch'
const LAYOUT_PRESETS: { id: LayoutId; title: string }[] = [
  { id: '3col', title: 'Three-column: agents + search | chat | chat + docview' },
  { id: '2col', title: 'Two-column: left margin + right margin chat' },
  { id: 'wide', title: 'Wide: agents + search | one large chat' },
  { id: 'grid', title: 'Grid: agents + search | 2×2 chat grid' },
  { id: 'touch', title: 'Touch: single-column inbox + chat (iPad)' },
]

/** Mini SVG diagram showing the layout arrangement */
function LayoutIcon({ id, size = 20 }: { id: LayoutId; size?: number }) {
  const s = size
  const g = 1 // gap
  const r = 0.5 // corner radius
  // All shapes use currentColor — opacity on the fan-item container handles visibility.
  // Differentiate shape types by opacity within the icon.
  const ap = 'currentColor'  // agents panel (full)
  const ch = 'currentColor'  // chat (full)
  const sr = 'currentColor'  // search
  const dv = 'currentColor'  // docview

  // Document: outlined rectangle with horizontal lines (looks like paper).
  // SAME size in every preset — fixed at right side.
  const docW = s * 0.22
  const docX = s - docW
  const docY = s * 0.05
  const docH = s * 0.9
  const lineGap = docH / 6
  const docEl = (x: number = docX) => (
    <g>
      <rect x={x} y={docY} width={docW} height={docH} stroke="currentColor" strokeWidth={0.5} fill="none" rx={r} />
      {[1,2,3,4,5].map(i => (
        <line key={i} x1={x + docW*0.15} y1={docY + lineGap*i} x2={x + docW*0.85} y2={docY + lineGap*i} stroke="currentColor" strokeWidth={0.35} opacity={0.45} />
      ))}
    </g>
  )

  const layouts: Record<LayoutId, React.JSX.Element> = {
    '3col': (
      // [agents/search] [chat] [chat+docview] | DOC
      <>
        <rect x={0} y={0} width={s*0.16} height={s*0.55} rx={r} fill={ap} />
        <rect x={0} y={s*0.55+g} width={s*0.16} height={s*0.45-g} rx={r} fill={sr} />
        <rect x={s*0.16+g} y={0} width={s*0.22-g} height={s} rx={r} fill={ch} />
        <rect x={s*0.38+g} y={0} width={s*0.22-g} height={s*0.7} rx={r} fill={ch} />
        <rect x={s*0.38+g} y={s*0.7+g} width={s*0.22-g} height={s*0.3-g} rx={r} fill={dv} />
        {docEl()}
      </>
    ),
    '2col': (
      // [agents/search + chat] | DOC | [chat]
      <>
        <rect x={0} y={0} width={s*0.16} height={s*0.55} rx={r} fill={ap} />
        <rect x={0} y={s*0.55+g} width={s*0.16} height={s*0.45-g} rx={r} fill={sr} />
        <rect x={s*0.16+g} y={0} width={s*0.24-g} height={s} rx={r} fill={ch} />
        {docEl(s*0.4+g)}
        <rect x={s*0.62+g} y={0} width={s*0.22-g} height={s} rx={r} fill={ch} />
      </>
    ),
    'wide': (
      // [agents/search] [wide chat] | DOC
      <>
        <rect x={0} y={0} width={s*0.16} height={s*0.55} rx={r} fill={ap} />
        <rect x={0} y={s*0.55+g} width={s*0.16} height={s*0.45-g} rx={r} fill={sr} />
        <rect x={s*0.16+g} y={0} width={s*0.44-g} height={s} rx={r} fill={ch} />
        {docEl()}
      </>
    ),
    'grid': (
      // [agents/search] [2x2 chats] | DOC
      <>
        <rect x={0} y={0} width={s*0.16} height={s*0.55} rx={r} fill={ap} />
        <rect x={0} y={s*0.55+g} width={s*0.16} height={s*0.45-g} rx={r} fill={sr} />
        <rect x={s*0.16+g} y={0} width={s*0.22-g} height={s*0.5-g/2} rx={r} fill={ch} />
        <rect x={s*0.38+g} y={0} width={s*0.22-g} height={s*0.5-g/2} rx={r} fill={ch} />
        <rect x={s*0.16+g} y={s*0.5+g/2} width={s*0.22-g} height={s*0.5-g/2} rx={r} fill={ch} />
        <rect x={s*0.38+g} y={s*0.5+g/2} width={s*0.22-g} height={s*0.5-g/2} rx={r} fill={ch} />
        {docEl()}
      </>
    ),
    'touch': (
      // [single column: inbox strip + chat] | DOC
      <>
        <rect x={0} y={0} width={s*0.5} height={s*0.16} rx={r} fill={sr} />
        <rect x={0} y={s*0.16+g} width={s*0.5} height={s*0.84-g} rx={r} fill={ch} />
        {docEl()}
      </>
    ),
  }

  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} style={{ display: 'block' }}>
      {layouts[id]}
    </svg>
  )
}

function isFleetHidden() {
  return localStorage.getItem('fleet-hud-expanded') !== '1'
}

// ── FleetIconPill ────────────────────────────────────────────────────────────

interface FleetIconPillProps { mainEditor: Editor }

export function FleetIconPill({ mainEditor }: FleetIconPillProps) {
  const agents = useFleetAgents()
  const [hidden, setHidden] = useState(() => isFleetHidden())
  const [dragging, setDragging] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  const [, setDragAnchor] = useState<{ x: number; y: number } | null>(null)

  const aliveCount = agents.filter((a: any) => !a.dead && !a.human).length

  // Refs for closure-stable drag state (used inside window listeners)
  const justDraggedRef = useRef(false)
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)
  const isDragRef = useRef(false)
  const selectedIdxRef = useRef<number | null>(null)
  const agentsRef = useRef(agents)
  agentsRef.current = agents

  /** Click handler — toggle HUD expanded state (suppressed after a drag). */
  const handleClick = useCallback(() => {
    if (justDraggedRef.current) {
      justDraggedRef.current = false
      return
    }
    const wasHidden = isFleetHidden()
    localStorage.setItem('fleet-hud-expanded', wasHidden ? '1' : '0')
    setHidden(!wasHidden)
    // Tell FleetHUD to toggle
    window.dispatchEvent(new CustomEvent('fleet-hud-toggle'))
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
          createFleetLayout(mainEditor, agentsRef.current, LAYOUT_PRESETS[idx].id as any)
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
        {/* Basestar SVG with agent count knocked out via mask */}
        <svg viewBox="0 0 960 960" width={27} height={27} aria-hidden="true"
          style={{ display: 'block', flexShrink: 0 }}>
          <defs>
            <mask id="fleet-count-mask">
              {/* White = visible, black = knocked out */}
              <rect width="960" height="960" fill="white" />
              {aliveCount > 0 && (
                <text x="480" y="580" textAnchor="middle" dominantBaseline="central"
                  fill="black" fontSize={aliveCount >= 10 ? 210 : 240}
                  fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
                  fontWeight="700">{aliveCount}</text>
              )}
            </mask>
          </defs>
          <g mask="url(#fleet-count-mask)" fill="currentColor">
            <g transform="translate(0,960) scale(1,-1)">
              <path d="M130 865 c0 -15 45 -94 111 -197 60 -94 116 -183 124 -197 14 -28 34 -131 60 -306 23 -161 21 -155 55 -155 35 0 29 -21 69 238 17 106 38 206 46 222 8 16 64 105 125 199 116 179 132 221 84 221 -18 0 -63 -33 -162 -120 -84 -74 -145 -120 -159 -120 -23 0 -36 9 -194 147 -76 66 -115 93 -133 93 -21 0 -26 -5 -26 -25z"/>
              <path d="M467 883 c-3 -5 -11 -45 -18 -91 -11 -73 -11 -85 3 -99 11 -10 25 -13 42 -9 30 7 33 31 13 135 -11 59 -27 85 -40 64z"/>
              <path d="M268 260 c-43 -76 -78 -144 -78 -149 0 -29 43 -3 114 68 l78 79 -12 71 c-6 39 -15 71 -18 71 -4 0 -42 -63 -84 -140z"/>
              <path d="M591 337 c-6 -35 -11 -68 -11 -73 0 -16 180 -175 191 -169 5 4 9 13 9 21 0 17 -161 284 -171 284 -4 0 -12 -28 -18 -63z"/>
            </g>
          </g>
        </svg>
      </span>

      {/* Layout preset fan — positioned above the icon */}
      {dragging && (
        <div
          className="fleet-icon-pill-fan"
          onPointerDown={e => e.stopPropagation()}
        >
          {LAYOUT_PRESETS.map((preset, i) => (
            <div
              key={preset.id}
              className={'fleet-icon-pill-fan-item' + (selectedIdx === i ? ' hovered' : '')}
              style={{ width: ITEM_W, height: ITEM_H, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              title={preset.title}
            >
              <LayoutIcon id={preset.id} size={ITEM_H - 4} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
