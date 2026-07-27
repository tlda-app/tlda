import { useState, useEffect, useRef, useCallback, useContext, useMemo } from 'react'
import { setStopRecordingCallback, setFinishPlacementCallback } from './tools/VoiceNoteTool'
import { setVoiceTarget, clearVoiceTarget, setVoiceAccumulator, stopRecording, isRecording, toggleRecording, voiceTap, maybeHandleVoiceSinkPointerDown } from './voice.mjs'
import { createPortal } from 'react-dom'
import { useEditor, useValue, stopEventPropagation, DefaultColorStyle } from 'tldraw'
import { toolNameHud } from './overlays/ToolNameHud'
import type { Editor, TLShapeId } from 'tldraw'
import { ProjectContext } from './PanelContext'
import { isSignalConnected, writeSignal, onAgentHeartbeat } from './useYjsSync'
import type { AgentHeartbeatSignal } from './useYjsSync'
import { TocTab, ZoneWidthSlider } from './panels/TocTab'
import { NotesTab } from './panels/NotesTab'
import { PrefsTab } from './panels/PrefsTab'
import { CornerButtonSlider, pickCornerSliderIndex } from './CornerButtonSlider'
import { isPhoneViewport } from './phoneViewport'

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

      // Screenshot capture handled by ScreenshotCapture component (via signal:screenshot-request)

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

type Tab = 'toc' | 'notes' | 'prefs'

export function DocumentPanel() {
  const doc = useContext(ProjectContext)
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
    <>
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
          {/* History tab removed — version wheel + bottom scrubber replaces it */}
          <button className={`doc-panel-tab ${tab === 'notes' ? 'active' : ''}`} onClick={() => setTab('notes')}>
            Notes
          </button>
          <button className={`doc-panel-tab doc-panel-tab--gear ${tab === 'prefs' ? 'active' : ''}`} onClick={() => setTab('prefs')}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 4.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7zM6 8a2 2 0 114 0 2 2 0 01-4 0z"/><path d="M9.4 1.2a1.5 1.5 0 00-2.8 0l-.3.9a.5.5 0 01-.7.3l-.8-.5a1.5 1.5 0 00-2 2l.5.8a.5.5 0 01-.3.7l-.9.3a1.5 1.5 0 000 2.8l.9.3a.5.5 0 01.3.7l-.5.8a1.5 1.5 0 002 2l.8-.5a.5.5 0 01.7.3l.3.9a1.5 1.5 0 002.8 0l.3-.9a.5.5 0 01.7-.3l.8.5a1.5 1.5 0 002-2l-.5-.8a.5.5 0 01.3-.7l.9-.3a1.5 1.5 0 000-2.8l-.9-.3a.5.5 0 01-.3-.7l.5-.8a1.5 1.5 0 00-2-2l-.8.5a.5.5 0 01-.7-.3l-.3-.9z"/></svg>
          </button>
        </div>
        {tab === 'toc' && <TocTab />}
        {/* HistoryTab removed */}
        {tab === 'notes' && <NotesTab />}
        {tab === 'prefs' && <PrefsTab />}
        <ZoneWidthSlider />
      </div>
    </>
  )
}

function usePhoneSizedViewport(): boolean {
  const [phone, setPhone] = useState(() => isPhoneViewport())
  useEffect(() => {
    if (typeof window === 'undefined') return
    const media = window.matchMedia?.('(max-width: 600px), (max-height: 600px)')
    const update = () => setPhone(isPhoneViewport())
    update()
    media?.addEventListener?.('change', update)
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    window.visualViewport?.addEventListener('resize', update)
    return () => {
      media?.removeEventListener?.('change', update)
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
      window.visualViewport?.removeEventListener('resize', update)
    }
  }, [])
  return phone
}

function useVisualViewportControlAnchor(active: boolean) {
  useEffect(() => {
    if (!active || typeof window === 'undefined') return
    let raf = 0
    const root = document.documentElement
    const apply = () => {
      raf = 0
      const vv = window.visualViewport
      const right = vv ? Math.max(0, window.innerWidth - vv.width - vv.offsetLeft) : 0
      const bottom = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0
      const top = vv ? Math.max(0, vv.offsetTop) : 0
      root.style.setProperty('--tlda-vv-right', `${Math.round(right)}px`)
      root.style.setProperty('--tlda-vv-bottom', `${Math.round(bottom)}px`)
      root.style.setProperty('--tlda-vv-top', `${Math.round(top)}px`)
    }
    const schedule = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(apply)
    }
    apply()
    window.addEventListener('resize', schedule)
    window.addEventListener('orientationchange', schedule)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('orientationchange', schedule)
      window.visualViewport?.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('scroll', schedule)
      root.style.removeProperty('--tlda-vv-right')
      root.style.removeProperty('--tlda-vv-bottom')
      root.style.removeProperty('--tlda-vv-top')
    }
  }, [active])
}

const IS_TOUCH_DEVICE = (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
  || (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches)
  || (typeof location !== 'undefined' && new URLSearchParams(location.search).has('forcetouch'))

function activateHlSlot(editor: Editor, idx: number) {
  const slot = PHONE_HL_SLOTS[idx]
  if (!slot) return
  if (slot.id === 'eraser') {
    editor.setCurrentTool('eraser')
  } else if (slot.id === 'select') {
    editor.setCurrentTool('select')
  } else if (slot.id === 'draw') {
    editor.setCurrentTool('draw')
  } else if (slot.id === 'hand') {
    editor.setCurrentTool('hand')
  } else {
    editor.setStyleForNextShapes(DefaultColorStyle, slot.id)
    editor.setCurrentTool('highlight')
  }
}

// ======================
// Phone / touch-tablet overlay
// ======================

import { HL_SLOTS, TLDRAW_ICON_BASE, hlMaskUrl, type HlSlot } from './highlighterSlots'

const PHONE_HL_SLOTS: HlSlot[] = [
  ...HL_SLOTS,
  { id: 'hand', color: '#888', label: 'move', svgIcon: `${TLDRAW_ICON_BASE}#tool-hand` },
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
  const [dragMode, setDragMode] = useState<'color' | null>(null)
  const [dragSlot, setDragSlot] = useState<number | null>(null)
  const [dragBtnRect, setDragBtnRect] = useState<DOMRect | null>(null)
  // Refs mirror the above for reliable reads in pointer handlers (state updates are async)
  const dragModeRef = useRef<'color' | null>(null)
  const dragSlotRef = useRef<number | null>(null)
  const dragBtnRectRef = useRef<DOMRect | null>(null)
  const colorIdxRef = useRef(0)
  const btnRef = useRef<HTMLButtonElement>(null)
  const lastTapRef = useRef(0)
  const singleTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressClickRef = useRef(false)
  colorIdxRef.current = colorIdx // keep ref current on every render — used in handlePointerMove

  const activateSlot = useCallback((idx: number) => activateHlSlot(editor, idx), [editor])

  // Phone undo gesture: quick double-tap on the highlighter button.
  const undoLastAction = useCallback(() => {
    editor.undo()
  }, [editor])

  const performSingleTap = useCallback(() => {
    if (mode === 'hand') {
      // Switch to highlight with current color
      activateSlot(colorIdx)
    } else {
      editor.setCurrentTool('hand')
    }
  }, [editor, mode, colorIdx, activateSlot])

  const handleTap = useCallback(() => {
    const now = Date.now()
    const elapsed = now - lastTapRef.current
    lastTapRef.current = now

    // Double-tap: undo. Defer single-tap behavior so the first tap does not add
    // a competing tool-change history entry before the undo gesture lands.
    if (elapsed < 400) {
      if (singleTapTimerRef.current) {
        clearTimeout(singleTapTimerRef.current)
        singleTapTimerRef.current = null
      }
      lastTapRef.current = 0 // reset so triple-tap doesn't re-trigger
      undoLastAction()
      return
    }

    if (singleTapTimerRef.current) clearTimeout(singleTapTimerRef.current)
    singleTapTimerRef.current = setTimeout(() => {
      singleTapTimerRef.current = null
      performSingleTap()
    }, 260)
  }, [performSingleTap, undoLastAction])

  // Drag handling — horizontal L/R for colors. Tap (no drag) toggles the tool.
  const dragStartX = useRef(0)
  const dragStartY = useRef(0)
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    dragStartX.current = e.clientX
    dragStartY.current = e.clientY
    const btnRect = btnRef.current?.getBoundingClientRect() ?? null
    dragBtnRectRef.current = btnRect
    setDragBtnRect(btnRect)
    setDragging(false)
    dragModeRef.current = null; setDragMode(null)
    dragSlotRef.current = null; setDragSlot(null)
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const dx = e.clientX - dragStartX.current

    // Determine drag mode if not yet set — read ref (always current, state update may not have committed)
    let currentMode = dragModeRef.current
    if (currentMode === null) {
      if (Math.abs(dx) > 10) {
        currentMode = 'color'
        dragModeRef.current = 'color'; setDragMode('color')
        setDragging(true)
      } else {
        return
      }
    }

    if (currentMode === 'color') {
      // Use absolute cursor position relative to button left edge (= slider right edge)
      const btnRect = dragBtnRectRef.current
      if (!btnRect) return
      const distFromBtnLeft = btnRect.left - e.clientX // positive = cursor to left of button
      const slotW = 29 // 27px slot + 2px gap (native sizes, no zoom)
      // 17.5 = padding(3) + halfSlot(13.5) + halfGap(1) — places snap boundary at
      // each slot's right edge (the far edge of the inter-slot gap from the button),
      // so cursor must visually enter the next slot to switch (no midway-in-gap snap).
      const slotPos = Math.round((distFromBtnLeft - 17.5) / slotW)
      // Active slot is the button itself — filter it from the slider
      const activeOrigIdx = colorIdxRef.current
      const filteredIndices = PHONE_HL_SLOTS.map((_, i) => i).filter(i => i !== activeOrigIdx)
      const clampedPos = Math.max(0, Math.min(filteredIndices.length - 1, slotPos))
      // Rightmost filtered slot = index 0 (just left of button), leftmost = last index
      const origIdx = filteredIndices[filteredIndices.length - 1 - clampedPos] ?? activeOrigIdx
      dragSlotRef.current = origIdx; setDragSlot(origIdx)
    }
  }, [])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    // Read refs — always current even if state update hasn't committed yet
    const currentMode = dragModeRef.current
    const currentSlot = dragSlotRef.current
    suppressClickRef.current = true
    if (currentMode === 'color' && currentSlot !== null) {
      activateSlot(currentSlot)
    } else if (currentMode === null) {
      handleTap()
    }
    dragModeRef.current = null; setDragging(false); setDragMode(null)
    dragSlotRef.current = null; setDragSlot(null)
    setDragBtnRect(null)
  }, [activateSlot, handleTap])

  const handlePointerCancel = useCallback((e: React.PointerEvent) => {
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    dragModeRef.current = null; dragSlotRef.current = null
    setDragging(false); setDragMode(null); setDragSlot(null); setDragBtnRect(null)
  }, [])

  const handleClick = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    stopEventPropagation(e)
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    handleTap()
  }, [handleTap])

  // Clear slider if window loses focus (app switch, cmd-tab, tab hide, etc.)
  useEffect(() => {
    const reset = () => {
      dragModeRef.current = null; dragSlotRef.current = null
      setDragging(false); setDragMode(null); setDragSlot(null); setDragBtnRect(null)
      if (singleTapTimerRef.current) {
        clearTimeout(singleTapTimerRef.current)
        singleTapTimerRef.current = null
      }
      toolNameHud.hide()
    }
    window.addEventListener('blur', reset)
    document.addEventListener('visibilitychange', reset)
    return () => {
      window.removeEventListener('blur', reset)
      document.removeEventListener('visibilitychange', reset)
    }
  }, [])

  // Drive the shared ToolNameHud while dragging colors. The slider in
  // HighlighterSliderShape uses the same bus, so only one pill ever exists.
  useEffect(() => {
    if (dragging && dragMode === 'color' && dragSlot != null) {
      const slot = PHONE_HL_SLOTS[dragSlot]
      if (slot) toolNameHud.show(slot.label, slot.color)
    } else {
      toolNameHud.hide()
    }
  }, [dragging, dragMode, dragSlot])

  // Button color always reflects current selection (not the dragged preview slot)
  const btnSlotDef = HL_SLOTS[colorIdx]
  const btnColor = btnSlotDef?.id === 'draw'
    ? (HL_SLOTS.find(s => s.id === activeColorName)?.color || '#1d1d1d')
    : (btnSlotDef?.color || HL_SLOTS[1].color)
  const isActive = mode !== 'hand'

  return (
    <>
      {/* Color slider popup — horizontal drag left.
          Position uses raw viewport coords (no zoom to compensate for). */}
      {dragging && dragMode === 'color' && dragBtnRect && (
        <div
          className="phone-hl-slider"
          style={{
            bottom: `${window.innerHeight - dragBtnRect.bottom}px`,
            right: `${window.innerWidth - dragBtnRect.left}px`,
          }}
          onPointerDown={stopEventPropagation}
          onTouchStart={stopEventPropagation}
        >
          {PHONE_HL_SLOTS.map((slot, i) => {
            if (i === colorIdx) return null // active slot is the button
            const isToolSlot = !!slot.svgIcon // eraser, select, draw — ring style like inactive button
            const slotColor = slot.id === 'draw'
              ? (HL_SLOTS.find(s => s.id === activeColorName)?.color || '#1d1d1d')
              : slot.color
            return <div
              key={slot.id}
              className={`phone-hl-slot${isToolSlot ? ' tool' : ' color'}${i === dragSlot ? ' active' : ''}`}
              style={{ '--hl-color': slotColor } as React.CSSProperties}
            >
              <span style={{
                display: 'block',
                width: 20,
                height: 20,
                WebkitMaskImage: `url("${hlMaskUrl(slot)}")`,
                maskImage: `url("${hlMaskUrl(slot)}")`,
                WebkitMaskSize: '100%', maskSize: '100%',
                WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat',
                WebkitMaskPosition: 'center', maskPosition: 'center',
                backgroundColor: 'currentColor',
              }} />
            </div>
          })}
        </div>
      )}
      {/* Color label is rendered by the shared ToolNameHud component;
          driven via the toolNameHud bus in the effect below. */}
      <button
        ref={btnRef}
        className={`phone-hl-btn${isActive ? ' active' : ''}`}
        style={{ '--hl-color': btnColor } as React.CSSProperties}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onTouchStart={stopEventPropagation}
        onTouchEnd={stopEventPropagation}
        onClick={handleClick}
      >
        {(() => {
          const toolId = editor.getCurrentToolId()
          const iconSlot = HL_SLOTS.find(s =>
            (s.id === 'eraser' && toolId === 'eraser') ||
            (s.id === 'select' && (toolId === 'browse' || toolId === 'select')) ||
            (s.id === 'draw' && toolId === 'draw')
          )
          // When a color (not a tool) is active, key off the active color so the
          // light-violet "outline" highlighter shows its peeling-note glyph.
          const iconSlot2 = iconSlot ?? HL_SLOTS.find(s => s.id === activeColorName)
          const iconUrl = iconSlot2 ? hlMaskUrl(iconSlot2) : `${TLDRAW_ICON_BASE}#tool-highlight`
          return <span style={{
            display: 'block',
            width: 20,
            height: 20,
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
  const doc = useContext(ProjectContext)
  const [menuOpen, setMenuOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('toc')
  const isPhone = usePhoneSizedViewport()
  const showButtonToc = doc?.format === 'slides' || isPhone || IS_TOUCH_DEVICE
  useVisualViewportControlAnchor(showButtonToc)
  useEffect(() => {
    if (!isPhone) return
    // Show toolbar when menu is open
    document.body.classList.toggle('phone-bar-visible', menuOpen)
  }, [isPhone, menuOpen])

  useEffect(() => {
    if (!isPhone) return
    document.body.classList.add('phone-mode')
    return () => { document.body.classList.remove('phone-mode') }
  }, [isPhone])

  useEffect(() => {
    if (!showButtonToc || isPhone) return
    document.body.classList.add('touch-toc-mode')
    return () => { document.body.classList.remove('touch-toc-mode') }
  }, [showButtonToc, isPhone])

  if (!showButtonToc) return null

  return (
    <>
      {/* Menu toggle — top right: opens TOC + shows toolbar */}
      <button
        className="phone-toc-btn"
        aria-label={menuOpen ? 'Close table of contents' : 'Open table of contents'}
        onClick={() => setMenuOpen(!menuOpen)}
        onPointerDown={stopEventPropagation}
        onPointerUp={stopEventPropagation}
        onTouchStart={stopEventPropagation}
        onTouchEnd={stopEventPropagation}
      >
        {menuOpen ? '✕' : '☰'}
      </button>

      {isPhone && (
        <>
          {/* Highlighter toggle — bottom right, drag for color slider */}
          <PhoneHighlighterButton />
          {/* Voice note button — bottom right, left of highlighter */}
          <VoiceNoteButtonInner />

          {/* Page number indicator — shows during scroll, fades out */}
          <PhonePageIndicator />
        </>
      )}

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
            <div className="doc-panel-tabs phone-panel-tabs">
              <button className={`doc-panel-tab ${tab === 'toc' ? 'active' : ''}`} onClick={() => setTab('toc')}>
                TOC
              </button>
              <button className={`doc-panel-tab ${tab === 'notes' ? 'active' : ''}`} onClick={() => setTab('notes')}>
                Notes
              </button>
              <button className={`doc-panel-tab doc-panel-tab--gear ${tab === 'prefs' ? 'active' : ''}`} onClick={() => setTab('prefs')} aria-label="Settings">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 4.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7zM6 8a2 2 0 114 0 2 2 0 01-4 0z"/><path d="M9.4 1.2a1.5 1.5 0 00-2.8 0l-.3.9a.5.5 0 01-.7.3l-.8-.5a1.5 1.5 0 00-2 2l.5.8a.5.5 0 01-.3.7l-.9.3a1.5 1.5 0 000 2.8l.9.3a.5.5 0 01.3.7l-.5.8a1.5 1.5 0 002 2l.8-.5a.5.5 0 01.7.3l.3.9a1.5 1.5 0 002.8 0l.3-.9a.5.5 0 01.7-.3l.8.5a1.5 1.5 0 002-2l-.5-.8a.5.5 0 01.3-.7l.9-.3a1.5 1.5 0 000-2.8l-.9-.3a.5.5 0 01-.3-.7l.5-.8a1.5 1.5 0 00-2-2l-.8.5a.5.5 0 01-.7-.3l-.3-.9z"/></svg>
              </button>
            </div>
            {tab === 'toc' && <TocTab />}
            {tab === 'notes' && <NotesTab />}
            {tab === 'prefs' && <PrefsTab />}
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

      // Screenshot capture handled by ScreenshotCapture component

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


// Highlighter button — rendered on desktop AND iPad. Only suppressed on
// actual phones, where the PhoneOverlay renders its own copy. iPad is a
// touch device but not a phone, so it gets the same layout as desktop.
export function HighlighterButton() {
  const isPhone = usePhoneSizedViewport()
  if (isPhone) return null
  return <PhoneHighlighterButton />
}
export function SemanticHighlightPill() { return null }

// ======================
// Voice Note Button
// ======================

function useVoiceNoteController() {
  const editor = useEditor()
  const hiddenTARef = useRef<HTMLTextAreaElement | null>(null)
  const keepRef = useRef<TLShapeId[]>([])
  const [recording, setRecording] = useState(false)
  const isPlacing = useValue('voice-placing', () => editor.getCurrentToolId() === 'voice-note', [editor])

  useEffect(() => {
    if (!_isTouchDevice) return
    const onDown = () => { keepRef.current = editor.getSelectedShapeIds() }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [editor])

  const cleanupPlacement = useCallback(({ stopVoice, resetTool }: { stopVoice: boolean; resetTool: boolean }) => {
    if (stopVoice && isRecording()) stopRecording()
    if (hiddenTARef.current) {
      clearVoiceTarget(hiddenTARef.current)
      hiddenTARef.current.remove()
      hiddenTARef.current = null
    }
    setStopRecordingCallback(null)
    setFinishPlacementCallback(null)
    setRecording(false)
    if (resetTool) editor.setCurrentTool('select')
  }, [editor])

  // initialPoint (page coords) seeds the ghost when there's no cursor — touch
  // passes a point just left of the button; mouse omits it and uses the cursor.
  const startPlacement = useCallback((initialPoint?: { x: number; y: number }) => {
    cleanupPlacement({ stopVoice: false, resetTool: false })
    const ta = document.createElement('textarea')
    ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none;width:1px;height:1px;top:-9999px'
    document.body.appendChild(ta)
    hiddenTARef.current = ta
    setVoiceTarget(ta, {
      getSendTargets: () => [],
      getAgentNames: () => ({}),
      getAgentColor: () => null,
      sendVoice: () => {},
    })
    if (!isRecording()) toggleRecording()
    setStopRecordingCallback(() => {
      cleanupPlacement({ stopVoice: true, resetTool: false })
    })
    setFinishPlacementCallback(() => {
      cleanupPlacement({ stopVoice: false, resetTool: false })
    })
    setRecording(true)
    editor.setCurrentTool('voice-note', initialPoint ? { initialPoint } : undefined)
  }, [cleanupPlacement, editor])

  // Desktop keeps the historical "voice-note button cancels/stops placement"
  // behavior. Touch uses the button as a note target as well, so stale
  // post-commit placement state must not turn the next tap into a pause.
  const cancelRecording = useCallback(() => {
    cleanupPlacement({ stopVoice: true, resetTool: true })
  }, [cleanupPlacement])

  const triggerFromElement = useCallback((source: HTMLElement) => {
    if (_isTouchDevice) {
      if (isPlacing) { cancelRecording(); return }
      if (recording) cleanupPlacement({ stopVoice: false, resetTool: false })

      const selectedIds = keepRef.current.length ? keepRef.current : editor.getSelectedShapeIds()
      if (selectedIds.length === 1) {
        const selected = editor.getShape(selectedIds[0]) as { type?: string } | undefined
        if (selected?.type === 'math-note') {
          reassertSelection(editor, selectedIds)
          if (!isRecording()) toggleRecording()
          return
        }
      }

      // No cursor on touch — seed the ghost just left of the button, in page
      // coords. The voice-note tool then tracks pencil hover and commits where
      // the pen taps (instead of dumping a note at viewport center).
      const r = source.getBoundingClientRect()
      const seed = editor.screenToPage({ x: r.left - 20, y: r.top + r.height / 2 })
      startPlacement(seed)
      return
    }
    if (recording || isPlacing) { cancelRecording(); return }
    startPlacement()
  }, [recording, isPlacing, cancelRecording, cleanupPlacement, startPlacement, editor])

  return { recording, isPlacing, triggerFromElement }
}

type VoiceButtonMode = 'dictate-selection' | 'voice-note'

const VOICE_BUTTON_MODE_KEY = 'tlda-phone-voice-button-mode'

function readVoiceButtonMode(): VoiceButtonMode {
  try {
    return localStorage.getItem(VOICE_BUTTON_MODE_KEY) === 'dictate-selection'
      ? 'dictate-selection'
      : 'voice-note'
  } catch {
    return 'voice-note'
  }
}

function VoiceNoteButtonInner() {
  const { recording, isPlacing, triggerFromElement } = useVoiceNoteController()
  const btnRef = useRef<HTMLButtonElement>(null)
  const suppressClickRef = useRef(false)
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)
  const dragAnchorRef = useRef<DOMRect | null>(null)
  const dragSlotRef = useRef<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [dragAnchor, setDragAnchor] = useState<DOMRect | null>(null)
  const [dragSlot, setDragSlot] = useState<number | null>(null)
  const [selectedMode, setSelectedMode] = useState<VoiceButtonMode>(readVoiceButtonMode)

  const voiceSlots = useMemo(() => [
    {
      id: 'dictate-selection',
      // State-aware action label: says what tapping will DO given the current
      // transcription state (resolved live at HUD-show time in onPointerMove).
      label: 'Toggle transcription on',
      color: '#7ab8a0',
      action: voiceTap,
      render: () => (
        <svg width="20" height="20" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <rect x="6.5" y="2" width="5" height="8" rx="2.5" fill="currentColor" stroke="none" />
          <path d="M3.5 8.5a5.5 5.5 0 0 0 11 0" />
          <line x1="9" y1="14" x2="9" y2="16" />
        </svg>
      ),
    },
    {
      id: 'voice-note',
      label: 'voice note',
      color: '#d7b950',
      action: () => btnRef.current && triggerFromElement(btnRef.current),
      render: () => (
        <svg width="20" height="20" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11.5 2.5H4.2A1.7 1.7 0 0 0 2.5 4.2V13.8A1.7 1.7 0 0 0 4.2 15.5H13.8A1.7 1.7 0 0 0 15.5 13.8V6.5Z" />
          <path d="M11.5 2.5V6.5H15.5" />
          <rect x="7.6" y="6" width="2.8" height="4" rx="1.4" fill="currentColor" stroke="none" />
          <path d="M6.3 9.2a2.7 2.7 0 0 0 5.4 0" strokeWidth="1.1" />
        </svg>
      ),
    },
  ], [triggerFromElement])

  const selectedSlot = voiceSlots.findIndex(slot => slot.id === selectedMode)

  const selectMode = useCallback((mode: VoiceButtonMode) => {
    setSelectedMode(mode)
    try { localStorage.setItem(VOICE_BUTTON_MODE_KEY, mode) } catch { /* private mode */ }
  }, [])

  const resetDrag = useCallback(() => {
    dragStartRef.current = null
    dragAnchorRef.current = null
    dragSlotRef.current = null
    setDragging(false)
    setDragAnchor(null)
    setDragSlot(null)
    toolNameHud.hide()
  }, [])

  const handleClick = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    voiceSlots[selectedSlot]?.action()
  }, [selectedSlot, voiceSlots])

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    stopEventPropagation(e)
    dragStartRef.current = { x: e.clientX, y: e.clientY }
    dragAnchorRef.current = e.currentTarget.getBoundingClientRect()
    dragSlotRef.current = null
    setDragSlot(null)
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [])

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    const start = dragStartRef.current
    const anchor = dragAnchorRef.current
    if (!start || !anchor) return
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    if (!dragging && Math.hypot(dx, dy) <= 8) return
    if (!dragging) {
      setDragging(true)
      setDragAnchor(anchor)
    }
    const idx = pickCornerSliderIndex({ clientX: e.clientX, anchorRect: anchor, count: voiceSlots.length })
    dragSlotRef.current = idx
    setDragSlot(idx)
    const slot = voiceSlots[idx]
    if (slot) {
      const label = slot.id === 'dictate-selection'
        ? (isRecording() ? 'Toggle transcription off' : 'Toggle transcription on')
        : slot.label
      toolNameHud.show(label, slot.color)
    }
  }, [dragging, voiceSlots])

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    const slot = dragSlotRef.current
    if (dragging && slot !== null) {
      suppressClickRef.current = true
      const selected = voiceSlots[slot]
      if (selected) {
        selectMode(selected.id as VoiceButtonMode)
        selected.action()
      }
      resetDrag()
      return
    }
    resetDrag()
  }, [dragging, resetDrag, selectMode, voiceSlots])

  const handlePointerCancel = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    resetDrag()
  }, [resetDrag])

  const cls = `voice-note-btn${recording ? ' recording' : ''}${isPlacing ? ' placing' : ''}`

  return (
    <>
      {dragging && dragAnchor && (
        <CornerButtonSlider
          anchorRect={dragAnchor}
          className="voice-action-slider"
          options={voiceSlots}
          activeIndex={dragSlot ?? selectedSlot}
        />
      )}
      <button
        ref={btnRef}
        className={cls}
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onTouchStart={stopEventPropagation}
        onTouchEnd={stopEventPropagation}
        title={_isTouchDevice
          ? (selectedMode === 'dictate-selection' ? 'Toggle transcription' : 'New voice note')
          : (recording ? 'Stop recording' : isPlacing ? 'Cancel placement' : 'Voice note')}
      >
        {voiceSlots[selectedSlot]?.render()}
      </button>
    </>
  )
}

// Target-follows-tap: tapping a note makes it the voice/dictation target —
// exactly like tapping a chat. The sink is a shape-prop accumulator: spoken
// text is written to the note's `text` prop via editor.updateShape, which
// re-renders the note live. NO edit mode is forced and selection is left
// untouched — the only thing a tap changes is where voice goes. Independent of
// recording state (the mic button owns on/off). When a note IS open in edit
// mode, its CodeMirror owns the sink instead (MathNoteShape), so we skip it
// here. Touch-only; desktop keeps its hidden-textarea placement flow.
function VoiceTargetFollowsSelection() {
  const editor = useEditor()
  const selectedIds = useValue('voice-sel', () => editor.getSelectedShapeIds(), [editor])
  const editingId = useValue('voice-editing', () => editor.getEditingShapeId(), [editor])
  // Stable accumulator callbacks per note id. A stable callback lets
  // setVoiceAccumulator's same-ref guard no-op on re-render (so it never resets
  // an in-progress dictation), while still re-registering after a chat focus
  // stole the sink, and switching notes registers the other note's callback.
  const accumsRef = useRef<Map<string, { onUpdate: (t: string) => void; onStop: () => void }>>(new Map())
  useEffect(() => {
    if (!_isTouchDevice) return
    if (selectedIds.length !== 1) return
    const id = selectedIds[0]
    const s = editor.getShape(id) as any
    if (!s || s.type !== 'math-note') return
    if (editingId === id) return // edit mode: CodeMirror owns the sink
    let a = accumsRef.current.get(id)
    if (!a) {
      // `base` = the note's text at the start of each recording session; spoken
      // text is appended after it. Snapshotted once per session (base===null),
      // reset on stop so the next session appends after the committed text.
      let base: string | null = null
      const onUpdate = (text: string) => {
        if (base === null) {
          const cur = ((editor.getShape(id) as any)?.props?.text as string) || ''
          base = cur ? cur + (/\s$/.test(cur) ? '' : ' ') : ''
        }
        editor.updateShape({ id, type: 'math-note' as any, props: { text: base + text } })
      }
      const onStop = () => { base = null }
      a = { onUpdate, onStop }
      accumsRef.current.set(id, a)
    }
    setVoiceAccumulator(a.onUpdate, null, a.onStop, 'note')
  }, [editor, selectedIds, editingId])
  return null
}

function VoiceSinkShapeTapTarget() {
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      maybeHandleVoiceSinkPointerDown(event)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [])
  return null
}

export function VoiceTargetFollower() {
  if (typeof window === 'undefined') return null
  return <><VoiceTargetFollowsSelection /><VoiceSinkShapeTapTarget /></>
}

export function VoiceNoteButton() {
  const isPhone = usePhoneSizedViewport()
  if (typeof window === 'undefined' || isPhone) return null
  return <VoiceNoteButtonInner />
}

// ======================
// Mic Toggle Button
// ======================
// Dictation is normally toggled by tapping Right Shift (voice.mjs). The iPad
// keyboard has no Right Shift, so this button exposes the same tap-to-toggle:
// tap to start dictating into the focused chat, tap again to stop. Lives in the
// bottom-right corner stack directly above the voice-note button.

// maxTouchPoints (not pointer:coarse) — a Magic Keyboard/trackpad makes the
// iPad's primary pointer "fine", which would wrongly disable note dictation.
const _isTouchDevice = IS_TOUCH_DEVICE

// tldraw clears the selection when an InFrontOfTheCanvas button is clicked — it
// reads the tap as an empty-canvas click, and the clear is deferred so it lands
// AFTER our onClick handler. Re-assert the selection we want across a few frames
// so it wins that race. Without this, tapping the mic / voice-note button
// deselects the targeted note.
function reassertSelection(editor: Editor, ids: TLShapeId[]) {
  // tldraw's post-click deselect lands within a couple hundred ms, so re-assert
  // immediately and again past that window (a select at ~250ms reliably sticks).
  const apply = () => editor.setSelectedShapes(ids)
  apply()
  requestAnimationFrame(apply)
  setTimeout(apply, 150)
  setTimeout(apply, 300)
}

export function MicToggleButton() {
  if (typeof window === 'undefined') return null
  return null
}
