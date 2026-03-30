import { useState, useEffect, useRef, useCallback, useContext, useMemo } from 'react'
import { setStopRecordingCallback, appendVoiceTranscript, clearVoiceTranscript, clearPendingPlacement, commitVoiceNote } from './tools/VoiceNoteTool'
const TLDRAW_ICON_BASE = 'https://cdn.tldraw.com/4.3.1/icons/icon/0_merged.svg'
import { createPortal } from 'react-dom'
import { useEditor, useValue, stopEventPropagation, DefaultColorStyle } from 'tldraw'
import type { Editor } from 'tldraw'
import { DocContext } from './PanelContext'
import { isSignalConnected, writeSignal, onAgentHeartbeat } from './useYjsSync'
import type { AgentHeartbeatSignal } from './useYjsSync'
import { TocTab } from './panels/TocTab'
import { HistoryTab } from './panels/HistoryTab'
import { NotesTab } from './panels/NotesTab'

import './DocumentPanel.css'

// ======================
// Ping button
// ======================

export function PingButton() {
  const editor = useEditor()
  const [state, setState] = useState<'idle' | 'sending' | 'success' | 'error'>('idle')

  const ping = useCallback(async () => {
    if (state === 'sending') return
    setState('sending')
    try {
      if (!isSignalConnected()) throw new Error('Signal not connected')
      const center = editor.getViewportScreenCenter()
      const pt = editor.screenToPage(center)
      writeSignal('signal:ping', {
        id: 'signal:ping',
        typeName: 'signal',
        type: 'ping',
        viewport: { x: pt.x, y: pt.y },
      })

      // Capture viewport screenshot and write to Yjs
      try {
        const viewportBounds = editor.getViewportPageBounds()
        const { blob } = await editor.toImage([], {
          bounds: viewportBounds,
          background: true,
          scale: 1,
          pixelRatio: 1,
        })
        const buf = await blob.arrayBuffer()
        const reader = new FileReader()
        const base64 = await new Promise<string>((resolve) => {
          reader.onload = () => {
            const result = reader.result as string
            resolve(result.split(',')[1]) // strip data:...;base64, prefix
          }
          reader.readAsDataURL(new Blob([buf], { type: 'image/png' }))
        })
        writeSignal('signal:screenshot', { data: base64, mimeType: 'image/png' })
      } catch (e) {
        console.warn('[Ping] Screenshot capture failed:', e)
      }

      setState('success')
      setTimeout(() => setState('idle'), 1500)
    } catch {
      setState('error')
      setTimeout(() => setState('idle'), 2000)
    }
  }, [editor, state])

  const portalRef = useRef<HTMLDivElement | null>(null)
  if (!portalRef.current) {
    portalRef.current = document.createElement('div')
    document.body.appendChild(portalRef.current)
  }
  useEffect(() => {
    return () => { portalRef.current?.remove(); portalRef.current = null }
  }, [])

  return createPortal(
    <button
      className={`ping-button-standalone ping-button-standalone--${state}`}
      onClick={ping}
      onPointerDown={stopEventPropagation}
      onPointerUp={stopEventPropagation}
      onTouchStart={stopEventPropagation}
      onTouchEnd={stopEventPropagation}
      disabled={state === 'sending'}
      title="Ping agent"
    >
      <TldaTittle size={27} fill="currentColor"/>
    </button>,
    portalRef.current,
  )
}

// ======================
// Main panel
// ======================

type Tab = 'history' | 'toc' | 'notes' | 'fleet'

export function DocumentPanel() {
  const doc = useContext(DocContext)
  const isHtml = doc?.format === 'html' || doc?.format === 'markdown'
  const [tab, setTab] = useState<Tab>('toc')
  const [open, setOpen] = useState(false)
  const [dragOpen, setDragOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  // Close on outside touch (touch devices only — desktop uses CSS :hover)
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (e.pointerType === 'mouse') return // desktop hover handles this
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  // Auto-open panel when a fleet drag enters the window — close when drag stops
  const dragTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    function onDragOver(e: DragEvent) {
      const types = e.dataTransfer?.types
      if (!types?.includes('text/plain') && !types?.includes('application/x-chat-attachment')) return
      if (!dragOpen) { setDragOpen(true); setTab('toc') }
      // Reset close timer on every dragover — if no dragover for 500ms, drag ended
      if (dragTimeout.current) clearTimeout(dragTimeout.current)
      dragTimeout.current = setTimeout(() => setDragOpen(false), 500)
    }
    function onDrop() { setDragOpen(false) }
    // Use window (not document) — TLDraw's capture-phase handlers on document
    // call stopImmediatePropagation, preventing same-target capture listeners
    window.addEventListener('dragover', onDragOver, true)
    window.addEventListener('drop', onDrop, true)
    return () => {
      window.removeEventListener('dragover', onDragOver, true)
      window.removeEventListener('drop', onDrop, true)
      if (dragTimeout.current) clearTimeout(dragTimeout.current)
    }
  }, [dragOpen])

  // TLDraw-native drop target: open panel when shapes are dragged to right edge
  useEffect(() => {
    function onTocHover(e: Event) {
      const active = (e as CustomEvent).detail?.active
      if (active) {
        setDragOpen(true)
        setTab('toc')
      } else {
        setDragOpen(false)
      }
    }
    window.addEventListener('toc-drop-hover', onTocHover)
    return () => window.removeEventListener('toc-drop-hover', onTocHover)
  }, [])

  return (
    <div
      ref={panelRef}
      className={`doc-panel${(open || dragOpen) ? ' doc-panel-open' : ''}${isHtml ? ' doc-panel--html' : ''}`}
      onPointerDown={(e) => {
        stopEventPropagation(e)
        // Touch tap on collapsed strip → open
        if ((e.nativeEvent as PointerEvent).pointerType !== 'mouse' && !open) {
          setOpen(true)
        }
      }}
      onPointerUp={stopEventPropagation}
      onPointerMove={stopEventPropagation}
      onTouchStart={stopEventPropagation}
      onTouchEnd={stopEventPropagation}
    >
      <div className="doc-panel-tabs">
        <button className={`doc-panel-tab ${tab === 'toc' ? 'active' : ''}`} onClick={() => setTab('toc')}>
          TOC
        </button>
        {!isHtml && (
          <button className={`doc-panel-tab ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>
            History
          </button>
        )}
        <button className={`doc-panel-tab ${tab === 'notes' ? 'active' : ''}`} onClick={() => setTab('notes')}>
          Notes
        </button>
      </div>
      {tab === 'toc' && <TocTab />}
      {tab === 'history' && !isHtml && <HistoryTab />}
      {tab === 'notes' && <NotesTab />}
    </div>
  )
}

// ======================
// Phone overlay (small screens)
// ======================

const IS_PHONE = typeof window !== 'undefined' && window.matchMedia('(max-width: 600px)').matches

// Color slots for the highlighter slider. Severity-ordered (red = most severe).
// Violet is reserved for the user's personal notes — not a reading-assist color.
// Browse tool icon: pointer + starburst sparkle (matches the toolbar button)
const _browseStarburst = (() => {
  const cx = 12.5, cy = 5.5, rOuter = 5, rInner = 1.8, spikes = 8
  const pts = []
  for (let i = 0; i < spikes * 2; i++) {
    const angle = (i * Math.PI) / spikes - Math.PI / 2
    const r = i % 2 === 0 ? rOuter : rInner
    pts.push(`${+(cx + Math.cos(angle) * r).toFixed(1)},${+(cy + Math.sin(angle) * r).toFixed(1)}`)
  }
  return pts.join(' ')
})()
const BROWSE_ICON_URL = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18"><path d="M2 4.5l1 11 2.8-3.5 4.2 1.8L2 4.5z" fill="currentColor"/><polygon points="${_browseStarburst}" fill="currentColor"/></svg>`
)}`

const HL_SLOTS: { id: string; color: string; label: string; svgIcon?: string }[] = [
  { id: 'eraser', color: '#888', label: 'Eraser', svgIcon: `${TLDRAW_ICON_BASE}#tool-eraser` },
  { id: 'black', color: '#1d1d1d', label: 'cut' },
  { id: 'light-red', color: '#dc2626', label: 'wrong' },
  { id: 'orange', color: '#ff8c40', label: 'expand' },
  { id: 'yellow', color: '#ffc940', label: 'question' },
  { id: 'grey', color: '#9fa1a4', label: 'compress' },
  { id: 'light-blue', color: '#4ea2e2', label: 'notation' },
  { id: 'light-green', color: '#65c365', label: 'approve' },
  { id: 'light-violet', color: '#e0d4f5', label: 'personal' },
  { id: 'zone-toggle', color: '#666', label: 'zone', svgIcon: `${TLDRAW_ICON_BASE}#tool-frame` },
  { id: 'select', color: '#666', label: 'browse', svgIcon: BROWSE_ICON_URL },
  { id: 'draw', color: '#666', label: 'pen', svgIcon: `${TLDRAW_ICON_BASE}#tool-pencil` },
]

function PhoneHighlighterButton() {
  const editor = useEditor()
  // Derive mode and colorIdx reactively from editor state — shared source of truth with zone-slider
  const activeToolId = useValue('toolId', () => editor.getCurrentToolId(), [editor])
  const activeColorName = useValue('color', () =>
    (editor.getInstanceState().stylesForNextShape?.['tldraw:color'] as string) || 'light-red',
    [editor]
  )
  const colorIdx = useMemo(() => {
    if (activeToolId === 'eraser') return HL_SLOTS.findIndex(s => s.id === 'eraser')
    if (activeToolId === 'draw') return HL_SLOTS.findIndex(s => s.id === 'draw')
    if (activeToolId === 'browse' || activeToolId === 'select') return HL_SLOTS.findIndex(s => s.id === 'select')
    const idx = HL_SLOTS.findIndex(s => s.id === activeColorName)
    return idx >= 0 ? idx : 4
  }, [activeToolId, activeColorName])
  const mode = activeToolId === 'highlight' ? 'highlight' : activeToolId === 'eraser' ? 'eraser' : 'hand'

  const [dragging, setDragging] = useState(false)
  const [dragSlot, setDragSlot] = useState<number | null>(null)
  const [dragBtnRect, setDragBtnRect] = useState<DOMRect | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const lastTapRef = useRef(0)

  const [zoneEnabled, setZoneEnabled] = useState(() =>
    typeof localStorage !== 'undefined' && localStorage.getItem('hl-zone-mode') === '1'
  )

  const activateSlot = useCallback((idx: number) => {
    const slot = HL_SLOTS[idx]
    if (slot.id === 'zone-toggle') {
      const next = !zoneEnabled
      setZoneEnabled(next)
      localStorage.setItem('hl-zone-mode', next ? '1' : '0')
      return
    }
    if (slot.id === 'eraser') {
      editor.setCurrentTool('eraser')
    } else if (slot.id === 'select') {
      editor.setCurrentTool('browse')
    } else if (slot.id === 'draw') {
      editor.setCurrentTool('draw')
    } else {
      editor.setStyleForNextShapes(DefaultColorStyle, slot.id)
      editor.setCurrentTool('highlight')
    }
  }, [editor, zoneEnabled])

  // Undo last highlight: find most recent highlight shape and delete it
  const undoLastHighlight = useCallback(() => {
    const allShapes = editor.getCurrentPageShapes()
    const highlights = allShapes
      .filter((s: any) => s.type === 'highlight')
      .sort((a: any, b: any) => {
        // Sort by index descending — highest index = most recently created
        return (b.index || '').localeCompare(a.index || '')
      })
    if (highlights.length > 0) {
      editor.deleteShape(highlights[0].id)
    }
  }, [editor])

  const handleTap = useCallback(() => {
    const now = Date.now()
    const elapsed = now - lastTapRef.current
    lastTapRef.current = now

    // Double-tap: undo last highlight
    if (elapsed < 400) {
      lastTapRef.current = 0 // reset so triple-tap doesn't re-trigger
      undoLastHighlight()
      return
    }

    if (mode === 'hand') {
      // Switch to highlight with current color
      activateSlot(colorIdx)
    } else {
      // Switch back to phone-hand (axis-locked scroll)
      editor.setCurrentTool('phone-hand')
    }
  }, [editor, mode, colorIdx, activateSlot, undoLastHighlight])

  // Drag handling for color slider — horizontal L/R
  const dragStartX = useRef(0)
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    dragStartX.current = e.clientX
    setDragBtnRect(btnRef.current?.getBoundingClientRect() ?? null)
    setDragging(false)
    setDragSlot(null)
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const dx = e.clientX - dragStartX.current
    if (Math.abs(dx) < 10 && !dragging) return
    if (!dragging) setDragging(true)
    // Slots laid out L→R: [eraser, yellow, green, blue, violet, orange]
    // Button is to the right. Drag left a little = orange (idx 5), a lot = eraser (idx 0)
    // Counter-scale for hires displays: CSS zoom makes slots visually larger but clientX is unscaled
    const hiresScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hires-scale')) || 1
    const slotWidth = 40 * hiresScale
    const steps = Math.round((-dx) / slotWidth) // positive = dragged left
    const idx = Math.max(0, Math.min(HL_SLOTS.length - 1, HL_SLOTS.length - steps))
    setDragSlot(idx)
  }, [dragging])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    if (dragging && dragSlot !== null) {
      activateSlot(dragSlot)
    } else if (!dragging) {
      handleTap()
    }
    setDragging(false)
    setDragSlot(null)
    setDragBtnRect(null)
  }, [dragging, dragSlot, activateSlot, handleTap])

  const handlePointerCancel = useCallback((e: React.PointerEvent) => {
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    setDragging(false)
    setDragSlot(null)
    setDragBtnRect(null)
  }, [])

  const activeSlot = dragSlot ?? colorIdx
  const activeSlotDef = HL_SLOTS[activeSlot]
  // For draw slot, show the current pen/highlight color instead of neutral gray
  const activeColor = activeSlotDef?.id === 'draw'
    ? (HL_SLOTS.find(s => s.id === activeColorName)?.color || '#1d1d1d')
    : (activeSlotDef?.color || HL_SLOTS[1].color)
  const isActive = mode !== 'hand'

  return (
    <>
      {/* Color slider popup — shown during drag, positioned at button circle */}
      {dragging && dragBtnRect && (
        <div
          className="phone-hl-slider"
          style={{
            bottom: `${window.innerHeight - dragBtnRect.bottom}px`,
            right: `${window.innerWidth - dragBtnRect.left + 6}px`,
          }}
          onPointerDown={stopEventPropagation}
          onTouchStart={stopEventPropagation}
        >
          {HL_SLOTS.map((slot, i) => (
            <div
              key={slot.id}
              className={`phone-hl-slot${i === dragSlot ? ' active' : ''}`}
              style={{ '--slot-color': slot.color } as React.CSSProperties}
            >
              {slot.svgIcon ? (
                <span className="phone-hl-slot-icon" style={{
                  display: 'block', width: 20, height: 20,
                  WebkitMaskImage: `url("${slot.svgIcon}")`,
                  maskImage: `url("${slot.svgIcon}")`,
                  WebkitMaskSize: '100%', maskSize: '100%',
                  WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat',
                  WebkitMaskPosition: 'center', maskPosition: 'center',
                  backgroundColor: slot.color,
                }} />
              ) : (
                <span className="phone-hl-slot-dot" />
              )}
            </div>
          ))}
        </div>
      )}
      {/* Label rendered outside slot hierarchy — position:fixed breaks inside transformed parents */}
      {dragging && dragSlot != null && (
        <span className="phone-hl-slot-label" style={{ '--slot-color': HL_SLOTS[dragSlot]?.color || '#666' } as React.CSSProperties}>
          {HL_SLOTS[dragSlot]?.id === 'zone-toggle'
            ? (zoneEnabled ? 'Disable zone' : 'Enable zone')
            : HL_SLOTS[dragSlot]?.label}
        </span>
      )}
      <button
        ref={btnRef}
        className={`phone-hl-btn${isActive ? ' active' : ''}`}
        style={{ '--hl-color': activeColor } as React.CSSProperties}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onTouchStart={stopEventPropagation}
        onTouchEnd={stopEventPropagation}
      >
        {(() => {
          const toolId = editor.getCurrentToolId()
          const iconSlot = HL_SLOTS.find(s =>
            (s.id === 'eraser' && toolId === 'eraser') ||
            (s.id === 'select' && (toolId === 'browse' || toolId === 'select')) ||
            (s.id === 'draw' && toolId === 'draw')
          )
          const iconUrl = iconSlot?.svgIcon ?? `${TLDRAW_ICON_BASE}#tool-highlight`
          return <span style={{
            display: 'block', width: 20, height: 20,
            WebkitMaskImage: `url("${iconUrl}")`,
            maskImage: `url("${iconUrl}")`,
            WebkitMaskSize: '100%', maskSize: '100%',
            WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat',
            WebkitMaskPosition: 'center', maskPosition: 'center',
            backgroundColor: isActive ? 'white' : 'currentColor',
          }} />
        })()}
      </button>
    </>
  )
}

function PhonePageIndicator() {
  const editor = useEditor()
  const [pageInfo, setPageInfo] = useState<{ current: number; total: number } | null>(null)
  const [visible, setVisible] = useState(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastCamY = useRef<number>(0)

  useEffect(() => {
    const update = () => {
      const cam = editor.getCamera()
      // Only show on meaningful vertical movement
      if (Math.abs(cam.y - lastCamY.current) < 0.5) return
      lastCamY.current = cam.y

      const pages = editor.getCurrentPageShapes()
        .filter(s => (s.type as string) === 'svg-page')
        .sort((a, b) => (a as any).y - (b as any).y)
      if (pages.length === 0) return

      const vp = editor.getViewportPageBounds()
      const vpMidY = vp.minY + vp.height / 2
      let closest = 0
      let minDist = Infinity
      for (let i = 0; i < pages.length; i++) {
        const py = (pages[i] as any).y + (pages[i].props as any).h / 2
        const d = Math.abs(py - vpMidY)
        if (d < minDist) { minDist = d; closest = i }
      }

      setPageInfo({ current: closest + 1, total: pages.length })
      setVisible(true)
      if (hideTimer.current) clearTimeout(hideTimer.current)
      hideTimer.current = setTimeout(() => setVisible(false), 1200)
    }
    editor.on('change', update)
    return () => {
      editor.off('change', update)
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [editor])

  if (!pageInfo) return null

  return (
    <div className={`phone-page-indicator${visible ? ' visible' : ''}`}>
      {pageInfo.current} / {pageInfo.total}
    </div>
  )
}

export function PhoneOverlay() {
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    if (!IS_PHONE) return
    // Show toolbar when menu is open
    document.body.classList.toggle('phone-bar-visible', menuOpen)
  }, [menuOpen])

  useEffect(() => {
    if (!IS_PHONE) return
    document.body.classList.add('phone-mode')
    return () => { document.body.classList.remove('phone-mode') }
  }, [])

  if (!IS_PHONE) return null

  return (
    <>
      {/* Menu toggle — top right: opens TOC + shows toolbar */}
      <button
        className="phone-toc-btn"
        onClick={() => setMenuOpen(!menuOpen)}
        onPointerDown={stopEventPropagation}
        onPointerUp={stopEventPropagation}
        onTouchStart={stopEventPropagation}
        onTouchEnd={stopEventPropagation}
      >
        {menuOpen ? '✕' : '☰'}
      </button>

      {/* Highlighter toggle — bottom right, drag for color slider */}
      <PhoneHighlighterButton />
      {/* Voice note button — bottom right, left of highlighter */}
      <VoiceNoteButton />

      {/* Page number indicator — shows during scroll, fades out */}
      <PhonePageIndicator />

      {/* TOC modal */}
      {menuOpen && (
        <div
          className="phone-toc-backdrop"
          onClick={() => setMenuOpen(false)}
          onPointerDown={stopEventPropagation}
          onTouchStart={stopEventPropagation}
        >
          <div
            className="phone-toc-modal"
            onClick={(e) => {
              // Close modal when a TOC item is tapped (navigates to section)
              if ((e.target as HTMLElement).closest('.toc-item')) {
                setTimeout(() => setMenuOpen(false), 150)
              } else {
                e.stopPropagation()
              }
            }}
            onPointerDown={stopEventPropagation}
            onTouchStart={stopEventPropagation}
          >
            <TocTab />
          </div>
        </div>
      )}
    </>
  )
}

// ======================
// Agent indicator (logo only, bottom-right)
// ======================

/** Tittle: circle with rotated-comma tail boolean-subtracted (no mask) */
const TITTLE_PATH = "M12.8,10.75c0,-1.76731 1.43269,-3.2 3.2,-3.2c1.76731,0 3.2,1.43269 3.2,3.2c0,1.61101 -1.19047,2.94396 -2.7397,3.16714c-0.02561,-0.04541 -0.03368,-0.10672 -0.0242,-0.18394c0.0689,-0.4218 0.2183,-0.8319 0.4482,-1.2303c0.2298,-0.3984 0.5171,-0.7265 0.8619,-0.9843c0.6206,-0.5155 0.7355,-0.9608 0.3448,-1.3358c-0.4137,-0.3983 -0.9424,-0.4101 -1.586,-0.0351c-1.1722,0.6562 -2.0686,1.6053 -2.6892,2.8473c-0.01089,0.02102 -0.02166,0.04203 -0.03231,0.06306c-0.6062,-0.5823 -0.98349,-1.40112 -0.98349,-2.30806z"

function TldaTittle({ size, className, fill = 'currentColor', stroke, strokeWidth }: {
  size: number, className?: string, fill?: string, stroke?: string, strokeWidth?: number
}) {
  return (
    <svg width={size} height={size} viewBox="12.3 7 7.4 7.4" className={className}>
      {stroke ? (
        <circle cx="16" cy="10.75" r="3.2" fill="none" stroke={stroke} strokeWidth={strokeWidth}/>
      ) : (
        <path d={TITTLE_PATH} fill={fill}/>
      )}
    </svg>
  )
}

type AgentState = 'offline' | 'listening' | 'thinking' | 'stale'

const STALE_MS = 30_000
const OFFLINE_MS = 60_000

export function AgentPill({ editor }: { editor: Editor }) {
  const [agentState, setAgentState] = useState<AgentState>('offline')
  const [agentName, setAgentName] = useState<string>('claude')
  const [pinging, setPinging] = useState(false)
  const lastHeartbeatRef = useRef<number>(0)
  const staleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const offlineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    function resetTimers(signal: AgentHeartbeatSignal) {
      lastHeartbeatRef.current = signal.timestamp
      setAgentState(signal.state as AgentState)
      if (signal.agent) setAgentName(signal.agent)

      if (staleTimerRef.current) clearTimeout(staleTimerRef.current)
      if (offlineTimerRef.current) clearTimeout(offlineTimerRef.current)

      staleTimerRef.current = setTimeout(() => setAgentState('stale'), STALE_MS)
      offlineTimerRef.current = setTimeout(() => setAgentState('offline'), OFFLINE_MS)
    }

    const unsub = onAgentHeartbeat(resetTimers)
    return () => {
      unsub()
      if (staleTimerRef.current) clearTimeout(staleTimerRef.current)
      if (offlineTimerRef.current) clearTimeout(offlineTimerRef.current)
    }
  }, [])

  const handlePing = useCallback(async () => {
    if (pinging) return
    setPinging(true)
    try {
      if (!isSignalConnected()) throw new Error('Signal not connected')
      const center = editor.getViewportScreenCenter()
      const pt = editor.screenToPage(center)
      writeSignal('signal:ping', {
        id: 'signal:ping',
        typeName: 'signal',
        type: 'ping',
        viewport: { x: pt.x, y: pt.y },
      })

      // Capture viewport screenshot
      try {
        const viewportBounds = editor.getViewportPageBounds()
        const { blob } = await editor.toImage([], {
          bounds: viewportBounds,
          background: true,
          scale: 1,
          pixelRatio: 1,
        })
        const buf = await blob.arrayBuffer()
        const reader = new FileReader()
        const base64 = await new Promise<string>((resolve) => {
          reader.onload = () => {
            const result = reader.result as string
            resolve(result.split(',')[1])
          }
          reader.readAsDataURL(new Blob([buf], { type: 'image/png' }))
        })
        writeSignal('signal:screenshot', { data: base64, mimeType: 'image/png' })
      } catch (e) {
        console.warn('[Ping] Screenshot capture failed:', e)
      }

      setTimeout(() => setPinging(false), 1500)
    } catch {
      setTimeout(() => setPinging(false), 2000)
    }
  }, [editor, pinging])

  return (
    <span
      className={`agent-indicator agent-${agentState}`}
      data-agent={agentName}
      onClick={handlePing}
      onPointerDown={e => e.stopPropagation()}
      onPointerUp={e => e.stopPropagation()}
      onTouchStart={e => e.stopPropagation()}
      onTouchEnd={e => e.stopPropagation()}
      title={
        agentState === 'offline' ? 'No agent connected' :
        agentState === 'listening' ? `${agentName === 'todd' ? 'Todd' : 'Claude'} listening — tap to ping` :
        agentState === 'thinking' ? `${agentName === 'todd' ? 'Todd' : 'Claude'} thinking` :
        'Agent may be disconnected — tap to ping'
      }
    >
      {agentState !== 'offline' && (
        <TldaTittle size={16} className="agent-indicator-logo"
          fill={agentState === 'stale' ? undefined : 'currentColor'}
          stroke={agentState === 'stale' ? 'currentColor' : undefined}
          strokeWidth={agentState === 'stale' ? 0.5 : undefined}
        />
      )}
    </span>
  )
}


// Desktop highlighter button — same as phone version, positioned by InFrontOfTheCanvas
export function HighlighterButton() {
  const isTouch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
  // On touch devices, the PhoneOverlay renders its own copy — don't duplicate
  if (isTouch) return null
  return <PhoneHighlighterButton />
}
export function SemanticHighlightPill() { return null }

// ======================
// Voice Note Button
// ======================

function VoiceNoteButtonInner() {
  const editor = useEditor()
  const [recording, setRecording] = useState(false)
  const recRef = useRef<any>(null)
  const transcriptRef = useRef('')

  const isPlacing = useValue('voice-placing', () => editor.getCurrentToolId() === 'voice-note', [editor])

  const cancelRecording = useCallback(() => {
    if (recRef.current) { recRef.current.stop(); recRef.current = null }
    transcriptRef.current = ''
    clearVoiceTranscript()
    clearPendingPlacement()
    setStopRecordingCallback(null)
    setRecording(false)
    editor.setCurrentTool('select')
  }, [editor])

  const startRecording = useCallback(() => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) return
    transcriptRef.current = ''
    clearVoiceTranscript()
    const rec = new SR()
    rec.continuous = true
    rec.interimResults = false
    rec.lang = 'en-US'
    rec.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) appendVoiceTranscript(e.results[i][0].transcript + ' ')
      }
    }
    rec.onend = () => {
      commitVoiceNote()
      if (recRef.current === rec) recRef.current = null
    }
    rec.start()
    recRef.current = rec
    // Register stop callback for the tool to call on placement
    setStopRecordingCallback(() => {
      if (recRef.current) { recRef.current.stop(); recRef.current = null }
      setRecording(false)
    })
    setRecording(true)
    // Enter ghost/placement mode immediately
    editor.setCurrentTool('voice-note')
  }, [editor])

  const handleClick = useCallback(() => {
    if (recording || isPlacing) {
      cancelRecording()
    } else {
      startRecording()
    }
  }, [recording, isPlacing, cancelRecording, startRecording])

  const cls = `voice-note-btn${recording ? ' recording' : ''}${isPlacing ? ' placing' : ''}`

  return (
    <button
      className={cls}
      onClick={handleClick}
      onPointerDown={stopEventPropagation}
      onPointerUp={stopEventPropagation}
      onTouchStart={stopEventPropagation}
      onTouchEnd={stopEventPropagation}
      title={recording ? 'Stop recording' : isPlacing ? 'Cancel placement' : 'Voice note'}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
        <rect x="6.5" y="1" width="5" height="8" rx="2.5" />
        <path d="M3 9a6 6 0 0 0 12 0" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        <line x1="9" y1="15" x2="9" y2="17" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
  )
}

export function VoiceNoteButton() {
  // Only render if SpeechRecognition is available
  if (typeof window === 'undefined') return null
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
  if (!SR) return null
  return <VoiceNoteButtonInner />
}

