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
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { stopEventPropagation, useUniqueSafeId } from 'tldraw'
import type { Editor } from 'tldraw'
import { useFleetAgents, useFleetIdentity } from '../fleet-data-adapter'
import { countAwakeFleetAgents } from '../fleet/agent-counts'
import { createFleetLayout } from '../shapes/fleet-utils'
import { CornerRailSlider } from '../CornerRailSlider'
import './FleetIconPill.css'

// Basestar hull paths (drawn in a flipped coord system: translate(0,960) scale(1,-1)).
// Shared by the open (filled) and minimized (outline) renders.
const BASESTAR_PATHS = (
  <>
    <path d="M130 865 c0 -15 45 -94 111 -197 60 -94 116 -183 124 -197 14 -28 34 -131 60 -306 23 -161 21 -155 55 -155 35 0 29 -21 69 238 17 106 38 206 46 222 8 16 64 105 125 199 116 179 132 221 84 221 -18 0 -63 -33 -162 -120 -84 -74 -145 -120 -159 -120 -23 0 -36 9 -194 147 -76 66 -115 93 -133 93 -21 0 -26 -5 -26 -25z"/>
    <path d="M467 883 c-3 -5 -11 -45 -18 -91 -11 -73 -11 -85 3 -99 11 -10 25 -13 42 -9 30 7 33 31 13 135 -11 59 -27 85 -40 64z"/>
    <path d="M268 260 c-43 -76 -78 -144 -78 -149 0 -29 43 -3 114 68 l78 79 -12 71 c-6 39 -15 71 -18 71 -4 0 -42 -63 -84 -140z"/>
    <path d="M591 337 c-6 -35 -11 -68 -11 -73 0 -16 180 -175 191 -169 5 4 9 13 9 21 0 17 -161 284 -171 284 -4 0 -12 -28 -18 -63z"/>
  </>
)

const DRAG_THRESHOLD = 6   // px before drag activates
const ITEM_W = 44          // px width of each preset tile
const ITEM_H = 44          // px height
const ITEM_GAP = 4         // px between tiles

// 'touch' preset removed: the fleet-touch-inbox shape's click-to-filter never
// landed (the filter write no-ops in the HUD overlay) and the shape is being
// retired for the normal-inbox evolution. The shape code/schema stay for the
// inbox-evolve dead-code cut; this just makes the broken layout unreachable.
type LayoutId = '3col' | '2col' | 'wide' | 'grid' | 'phone'
const LAYOUT_PRESETS: { id: LayoutId; title: string }[] = [
  { id: '3col', title: 'Three-column: agents + search | chat | chat + docview' },
  { id: '2col', title: 'Two-column: left margin + right margin chat' },
  { id: 'wide', title: 'Wide: agents + search | one large chat' },
  { id: 'grid', title: 'Grid: agents + search | 2×2 chat grid' },
  { id: 'phone', title: 'Phone reset: agents/inbox | chat | document' },
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
    'phone': (
      // Phone: three full-screen lanes: agents/inbox | chat | document.
      <>
        <rect x={0} y={0} width={s*0.25-g/2} height={s*0.38-g/2} rx={r} fill={ap} />
        <rect x={0} y={s*0.38+g/2} width={s*0.25-g/2} height={s*0.62-g/2} rx={r} fill={sr} />
        <rect x={s*0.25+g} y={0} width={s*0.28-g} height={s} rx={r} fill={ch} />
        {docEl(s*0.55+g)}
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

function isTouchLayoutControl() {
  if (typeof window === 'undefined') return false
  return document.body.classList.contains('phone-mode') ||
    window.matchMedia?.('(pointer: coarse)').matches ||
    navigator.maxTouchPoints > 0 ||
    new URLSearchParams(window.location.search).has('forcetouch')
}

function stopControlEvent(e: React.SyntheticEvent | Event) {
  stopEventPropagation(e)
}

function getPhoneCameraSettlingDelay() {
  if (typeof window === 'undefined') return 0
  const readinessWindow = window as Window & { __tldaPhoneCameraSettlingUntil?: number }
  const until = Number(readinessWindow.__tldaPhoneCameraSettlingUntil || 0)
  if (!Number.isFinite(until)) return 0
  return Math.max(0, until - Date.now())
}

function cleanUrlName(name: string | null) {
  return name?.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || ''
}

function setFleetHudExpanded(expanded: boolean) {
  localStorage.setItem('fleet-hud-expanded', expanded ? '1' : '0')
  window.dispatchEvent(new CustomEvent('fleet-hud-toggle', { detail: { expanded } }))
}

function applyFleetLayoutPreset({
  mainEditor,
  agents,
  presetId,
  onShown,
}: {
  mainEditor: Editor
  agents: ReturnType<typeof useFleetAgents>
  presetId: LayoutId
  onShown?: () => void
}) {
  const deadline = Date.now() + 5000
  let rafId: number | null = null
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let unsub: (() => void) | null = null
  let completed = false
  const cleanup = () => {
    if (rafId !== null) cancelAnimationFrame(rafId)
    rafId = null
    if (timeoutId !== null) clearTimeout(timeoutId)
    timeoutId = null
    unsub?.()
    unsub = null
  }
  const applyWhenReady = async () => {
    if (presetId === 'phone') {
      const delay = getPhoneCameraSettlingDelay()
      if (delay > 0) {
        if (timeoutId !== null) return
        timeoutId = setTimeout(() => {
          timeoutId = null
          applyWhenReady()
        }, Math.min(delay + 50, 1000))
        return
      }
    }
    // createFleetLayout is async (awaits whenDeviceReady before stamping
    // ownership) — must await so `created` is the boolean result, not a Promise.
    const created = await createFleetLayout(mainEditor, agents, presetId)
    if (created) {
      completed = true
      cleanup()
      if (isFleetHidden()) {
        setFleetHudExpanded(true)
        onShown?.()
      }
      requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('fleet-hud-reset')))
      return
    }
    if (Date.now() >= deadline) {
      completed = true
      cleanup()
      console.warn('[FleetLayout] Timed out waiting for document page bounds')
      return
    }
    rafId = requestAnimationFrame(applyWhenReady)
  }
  applyWhenReady()
  if (!completed && !unsub) {
    unsub = mainEditor.store.listen(({ changes }) => {
      const hasPageChange =
        Object.values(changes.added).some((r: any) => r.typeName === 'shape' && (r.type === 'svg-page' || r.type === 'html-page')) ||
        Object.values(changes.updated).some((pair: any) => {
          const r = pair[1]
          return r?.typeName === 'shape' && (r.type === 'svg-page' || r.type === 'html-page')
        })
      if (hasPageChange) applyWhenReady()
    }, { source: 'all', scope: 'document' })
  }
}

// ── FleetIconPill ────────────────────────────────────────────────────────────

interface FleetIconPillProps { mainEditor: Editor }

export function FleetIconPill({ mainEditor }: FleetIconPillProps) {
  const countMaskId = useUniqueSafeId('fleet-count-mask')
  const badgeRef = useRef<HTMLSpanElement>(null)
  const agents = useFleetAgents()
  const identity = useFleetIdentity()
  const [hidden, setHidden] = useState(() => isFleetHidden())
  const [dragging, setDragging] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  const [rangeIdx, setRangeIdx] = useState(0)
  const [, setDragAnchor] = useState<{ x: number; y: number } | null>(null)

  const aliveCount = countAwakeFleetAgents(agents)

  // Refs for closure-stable drag state (used inside window listeners)
  const justDraggedRef = useRef(false)
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)
  const isDragRef = useRef(false)
  const selectedIdxRef = useRef<number | null>(null)
  const agentsRef = useRef(agents)
  const autoLayoutAppliedRef = useRef<string | null>(null)
  const identifyingForUrlRef = useRef<string | null>(null)
  agentsRef.current = agents

  const applyPreset = useCallback((idx: number) => {
    const preset = LAYOUT_PRESETS[idx]
    applyFleetLayoutPreset({
      mainEditor,
      agents: agentsRef.current,
      presetId: preset.id,
      onShown: () => setHidden(false),
    })
    setPickerOpen(false)
  }, [mainEditor])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const requested = params.get('fleetLayout') as LayoutId | null
    if (!requested) return
    const idx = LAYOUT_PRESETS.findIndex(p => p.id === requested)
    if (idx < 0) return

    const requestedName = cleanUrlName(params.get('name'))
    if (requestedName && identity.name !== requestedName) {
      if (!identity.id && !identity.needsIdentity) return
      if (identifyingForUrlRef.current === requestedName) return
      identifyingForUrlRef.current = requestedName
      identity.login(requestedName)
        .catch(() => identity.register(requestedName))
        .finally(() => {
          if (identifyingForUrlRef.current === requestedName) identifyingForUrlRef.current = null
        })
      return
    }

    if (!identity.id) return
    const applyKey = `${requested}|${identity.id}`
    if (autoLayoutAppliedRef.current === applyKey) return
    autoLayoutAppliedRef.current = applyKey
    applyPreset(idx)
  }, [applyPreset, identity.id, identity.name, identity.login, identity.register])

  /** Click handler — desktop toggles HUD; touch opens the reachable layout fan. */
  const handleClick = useCallback((e: React.MouseEvent) => {
    stopControlEvent(e)
    if (justDraggedRef.current) {
      justDraggedRef.current = false
      return
    }
    if (isTouchLayoutControl()) {
      setPickerOpen(open => !open)
      return
    }
    const wasHidden = isFleetHidden()
    setFleetHudExpanded(wasHidden)
    setHidden(!wasHidden)
  }, [])

  const previewLayoutPreset = useCallback((idx: number) => {
    setRangeIdx(idx)
    setSelectedIdx(idx)
  }, [])

  const resetRangeDrag = useCallback(() => {
    setDragging(false)
    setSelectedIdx(null)
  }, [])

  const commitLayoutPreset = useCallback((idx: number) => {
    setRangeIdx(idx)
    applyPreset(idx)
    justDraggedRef.current = true
    resetRangeDrag()
  }, [applyPreset, resetRangeDrag])

  const tapFleetButton = useCallback(() => {
    if (isTouchLayoutControl()) {
      setPickerOpen(open => !open)
      return
    }
    const wasHidden = isFleetHidden()
    setFleetHudExpanded(wasHidden)
    setHidden(!wasHidden)
  }, [])

  const layoutSliderOptions = useMemo(() => LAYOUT_PRESETS.map(preset => ({
    id: preset.id,
    label: preset.title,
    render: () => <LayoutIcon id={preset.id} size={20} />,
  })), [])

  /** Pointer down — stop propagation (prevents TLDraw interference) and set up drag listeners. */
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    stopControlEvent(e)

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
        stopControlEvent(ev)
        // Fan opens leftward from the bottom-right corner, so dragging LEFT
        // slides through the presets; dragging right (wrong way) selects the 0th.
        const idx = ev.clientX > s.x
          ? 0
          : Math.max(0, Math.min(LAYOUT_PRESETS.length - 1, Math.floor((s.x - ev.clientX) / (ITEM_W + ITEM_GAP))))
        selectedIdxRef.current = idx
        setSelectedIdx(idx)
      }
    }

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onCancel, true)
      isDragRef.current = false
      dragStartRef.current = null
      selectedIdxRef.current = null
      setDragging(false)
      setSelectedIdx(null)
      setDragAnchor(null)
    }

    const onUp = (ev: PointerEvent) => {
      stopControlEvent(ev)
      if (isDragRef.current) {
        const idx = selectedIdxRef.current
        if (idx !== null) {
          applyPreset(idx)
        }
        justDraggedRef.current = true  // suppress the upcoming onClick
      }
      cleanup()
    }

    const onCancel = () => { cleanup() }

    // TLDraw and fleet panels can stop bubble propagation. Capture-phase
    // listeners keep layout release working when the finger lifts over a panel.
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onCancel, true)
  }, [applyPreset])

  return (
    <div
      className={'fleet-icon-pill-container' + (hidden ? ' fleet-icon-pill--hidden' : '')}
      title={hidden ? 'Fleet shapes hidden — click to show' : 'Fleet — click to hide, drag for layout'}
    >
      <span
        ref={badgeRef}
        className="fleet-icon-pill-badge"
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerUp={stopControlEvent}
        onTouchStart={stopControlEvent}
        onTouchEnd={stopControlEvent}
        role="button"
        aria-label={`Fleet: ${aliveCount} agent${aliveCount !== 1 ? 's' : ''}`}
        style={{ touchAction: 'none' }}
      >
        {/* Basestar SVG. Open = filled hull (agent count knocked out via mask).
            Minimized = hollow outline of the same hull — a form difference, not a
            brightness one, so the toggle state reads at a glance. In the hollow
            state the count is drawn as a solid glyph (no fill to knock it out of). */}
        <svg viewBox="0 0 960 960" width={20} height={20} aria-hidden="true"
          style={{ display: 'block', flexShrink: 0 }}>
          {hidden ? (
            <>
              <g fill="none" stroke="currentColor" strokeWidth={26} strokeLinejoin="round">
                <g transform="translate(0,960) scale(1,-1)">{BASESTAR_PATHS}</g>
              </g>
              {aliveCount > 0 && (
                <text x="480" y="560" textAnchor="middle" dominantBaseline="central"
                  fill="currentColor" fontSize={aliveCount >= 10 ? 190 : 220}
                  fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
                  fontWeight="700">{aliveCount}</text>
              )}
            </>
          ) : (
            <>
              <defs>
                <mask id={countMaskId}>
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
              <g mask={`url(#${countMaskId})`} fill="currentColor">
                <g transform="translate(0,960) scale(1,-1)">{BASESTAR_PATHS}</g>
              </g>
            </>
          )}
        </svg>
      </span>

      {isTouchLayoutControl() && (
        <CornerRailSlider
          anchorRef={badgeRef}
          className="fleet-layout-slider"
          ariaLabel="Fleet layout"
          options={layoutSliderOptions}
          value={rangeIdx}
          onPreview={previewLayoutPreset}
          onCommit={commitLayoutPreset}
          onTap={tapFleetButton}
        />
      )}

      {/* Layout preset fan — positioned above the icon */}
      {(dragging || pickerOpen) && (
        <div
          className="fleet-icon-pill-fan"
          onPointerDown={stopControlEvent}
          onPointerUp={stopControlEvent}
          onTouchStart={stopControlEvent}
          onTouchEnd={stopControlEvent}
        >
          {LAYOUT_PRESETS.map((preset, i) => (
            <div
              key={preset.id}
              className={'fleet-icon-pill-fan-item' + (selectedIdx === i ? ' hovered' : '')}
              style={{ width: ITEM_W, height: ITEM_H, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              title={preset.title}
              onClick={(e) => { stopControlEvent(e); applyPreset(i) }}
              onPointerDown={stopControlEvent}
            >
              <LayoutIcon id={preset.id} size={ITEM_H - 4} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
