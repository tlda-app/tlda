/**
 * HighlighterSlider — ghost color/tool slider rendered in InFrontOfTheCanvas.
 *
 * The parent tl-canvas__in-front div calls editor.markEventAsHandled on
 * pointerDown/pointerUp, so events on elements with pointerEvents:'all'
 * inside it are automatically marked as handled — tldraw won't process them
 * through the current tool. No stopPropagation, no dispatch wrapping.
 *
 * On iPad: only responds to pen (isPen), only shows in pen mode.
 * On desktop: responds to mouse.
 */
import { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react'
import {
  useEditor,
  useValue,
  DefaultColorStyle,
} from 'tldraw'
import { toolNameHud } from '../overlays/ToolNameHud'
import { getPref, subscribePref } from '../preferences'


const highlightColors: Record<string, string> = {
  black: '#1d1d1d', grey: '#9fa1a4', 'light-violet': '#e0d4f5',
  violet: '#c77cff', blue: '#4ea2e2', 'light-blue': '#b7d9f5',
  yellow: '#ffc940', orange: '#ff8c40', green: '#65c365',
  'light-green': '#c5e8c5', 'light-red': '#f5c5c5', red: '#ff6b6b',
}

import { HL_SLOTS, TLDRAW_ICON_BASE } from '../highlighterSlots'

const isTouch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
const DOT_SIZE = 14
const DOT_GAP = 6

export function HighlighterSlider() {
  // Hide in embed mode (fleet shared doc iframe)
  const isEmbed = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('embed')
  // Default ON. Toggled from the prefs menu (server-backed pref).
  const [zoneEnabled, setZoneEnabled] = useState(() => getPref('hl-zone-enabled'))
  const [zoneWidth, setZoneWidth] = useState(() => {
    const stored = parseInt(typeof localStorage !== 'undefined' ? (localStorage.getItem('zone-width') || '') : '')
    return isNaN(stored) ? 60 : Math.max(20, Math.min(250, stored))
  })
  // subscribePref fires synchronously in-tab the instant the pref changes — no polling.
  useEffect(() => subscribePref(() => setZoneEnabled(getPref('hl-zone-enabled'))), [])
  useEffect(() => {
    const handler = (e: Event) => setZoneWidth((e as CustomEvent).detail)
    window.addEventListener('zone-width-change', handler)
    return () => window.removeEventListener('zone-width-change', handler)
  }, [])
  const editor = useEditor()
  const isPenMode = useValue('is pen mode', () => editor.getInstanceState().isPenMode, [editor])
  const penColor = useValue('pen color', () => {
    const colorName = (editor.getInstanceState().stylesForNextShape?.['tldraw:color'] as string) || 'black'
    return highlightColors[colorName] || '#1d1d1d'
  }, [editor])

  // Derive activeIdx reactively from editor state — shared source of truth with button-slider
  const activeToolId = useValue('toolId', () => editor.getCurrentToolId(), [editor])
  const activeColorName = useValue('colorName', () =>
    (editor.getInstanceState().stylesForNextShape?.['tldraw:color'] as string) || 'yellow',
    [editor]
  )
  const activeIdx = useMemo(() => {
    if (activeToolId === 'eraser') return HL_SLOTS.findIndex(s => s.id === 'eraser')
    if (activeToolId === 'draw') return HL_SLOTS.findIndex(s => s.id === 'draw')
    if (activeToolId === 'browse' || activeToolId === 'select') return HL_SLOTS.findIndex(s => s.id === 'select')
    const idx = HL_SLOTS.findIndex(s => s.id === activeColorName)
    return idx >= 0 ? idx : 4
  }, [activeToolId, activeColorName])

  const [cursorY, setCursorY] = useState<number | null>(null)
  const [cursorX, setCursorX] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [dragStartY, setDragStartY] = useState(0)
  const lastTapTime = useRef(0)
  const [showHud, setShowHud] = useState(false)
  const hudFadeRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Dynamically measure TOC panel height so slider starts below it
  const [tocBottom, setTocBottom] = useState(0)
  useLayoutEffect(() => {
    const tocEl = document.querySelector('.doc-panel') as HTMLElement | null
    if (!tocEl) return
    const update = () => {
      const rect = tocEl.getBoundingClientRect()
      setTocBottom(rect.bottom)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(tocEl)
    return () => ro.disconnect()
  }, [])

  // Reset drag state on blur — must be before early returns (hooks rule)
  useEffect(() => {
    const onBlur = () => {
      if (hudFadeRef.current) { clearTimeout(hudFadeRef.current); hudFadeRef.current = null }
      setShowHud(false)
      setDragging(false)
      setDragIdx(null)
      setDragStartY(0)
      setCursorY(null)
      setCursorX(null)
      toolNameHud.hide()
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [])

  // Drive shared ToolNameHud while dragging — replaces the inline pill that
  // used to render here. PhoneHighlighterButton uses the same bus. Must
  // come BEFORE the early returns (hooks rule).
  const _displayIdxForHud = dragIdx ?? activeIdx
  useEffect(() => {
    if (!showHud) { toolNameHud.hide(); return }
    const slot = HL_SLOTS[_displayIdxForHud]
    if (!slot) { toolNameHud.hide(); return }
    const hudColor = slot.id === 'draw' ? penColor : (slot.color || '#888')
    if (dragging) {
      toolNameHud.show(slot.label, hudColor)
    } else {
      toolNameHud.fade()
    }
  }, [showHud, _displayIdxForHud, dragging, penColor])

  // Only show when zone mode is enabled and not in embed mode
  if (isEmbed) return null
  if (!zoneEnabled) return null
  if (isTouch && !isPenMode) return null

  const activateSlot = (idx: number) => {
    const slot = HL_SLOTS[idx]
    if (slot.id === 'eraser') {
      editor.setCurrentTool('eraser')
    } else if (slot.id === 'select') {
      editor.setCurrentTool('select')
    } else if (slot.id === 'draw') {
      editor.setCurrentTool('draw')
    } else {
      editor.setStyleForNextShapes(DefaultColorStyle, slot.id)
      editor.setCurrentTool('highlight')
    }
  }

  const undoLastHighlight = () => {
    const shapes = editor.getCurrentPageShapes()
    const highlights = shapes
      .filter((s: any) => s.type === 'highlight')
      .sort((a: any, b: any) => (b.index || '').localeCompare(a.index || ''))
    if (highlights.length > 0) editor.deleteShape(highlights[0].id)
  }

  const sliderTop = (cy: number, centerIdx: number) =>
    cy - centerIdx * (DOT_SIZE + DOT_GAP) - DOT_SIZE / 2

  // No stopPropagation — tl-canvas__in-front parent already calls markEventAsHandled
  const handlePointerDown = (e: React.PointerEvent) => {
    if (isTouch && e.pointerType !== 'pen') return

    const now = Date.now()
    if (now - lastTapTime.current < 400) {
      undoLastHighlight()
      lastTapTime.current = 0
      return
    }
    lastTapTime.current = now
    setDragStartY(e.clientY)
    setCursorX(e.clientX)
    setDragging(false)
    setDragIdx(null)
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  const handlePointerMove = (e: React.PointerEvent) => {
    if (isTouch && e.pointerType !== 'pen') return
    setCursorY(e.clientY)
    setCursorX(e.clientX)
    if (!dragging && dragStartY && Math.abs(e.clientY - dragStartY) > 6) {
      setDragging(true)
      setShowHud(true)
      if (hudFadeRef.current) clearTimeout(hudFadeRef.current)
    }
    if (dragging) {
      const top = sliderTop(dragStartY, activeIdx)
      const relY = e.clientY - top
      const idx = Math.max(0, Math.min(HL_SLOTS.length - 1, Math.floor(relY / (DOT_SIZE + DOT_GAP))))
      setDragIdx(idx)
    }
  }

  const handlePointerUp = (e: React.PointerEvent) => {
    if (isTouch && e.pointerType !== 'pen') return
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    if (dragging && dragIdx !== null) {
      activateSlot(dragIdx)
    } else if (!dragging && dragStartY) {
      const cur = editor.getCurrentToolId()
      if (cur === 'highlight' || cur === 'eraser') {
        editor.setCurrentTool('select')
      } else {
        activateSlot(activeIdx)
      }
    }
    setDragging(false)
    setDragIdx(null)
    setDragStartY(0)
    setCursorY(null)
    setCursorX(null)
    if (hudFadeRef.current) clearTimeout(hudFadeRef.current)
    hudFadeRef.current = setTimeout(() => setShowHud(false), 500)
  }

  const resetDrag = () => {
    if (hudFadeRef.current) { clearTimeout(hudFadeRef.current); hudFadeRef.current = null }
    setShowHud(false)
    setDragging(false)
    setDragIdx(null)
    setDragStartY(0)
    setCursorY(null)
    setCursorX(null)
  }

  const handlePointerCancel = (_e: React.PointerEvent) => {
    resetDrag()
  }

  const handlePointerEnter = (e: React.PointerEvent) => {
    if (isTouch && e.pointerType !== 'pen') return
    setCursorY(e.clientY)
    setCursorX(e.clientX)
  }

  const handlePointerLeave = (_e: React.PointerEvent) => {
    if (!dragging) { setCursorY(null); setCursorX(null) }
  }

  const displayIdx = dragIdx ?? activeIdx
  const displayY = dragging ? dragStartY : cursorY
  const showSlider = displayY !== null
  const top = displayY ? sliderTop(displayY, activeIdx) : 0

  return (
    <div
      className="desktop-hl-zone"
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      style={{
        position: 'absolute', right: 0, top: tocBottom || '10%', bottom: '10%', width: zoneWidth,
        zIndex: 999, cursor: 'pointer', touchAction: 'none',
        pointerEvents: 'all',
      }}
    >
      {/* Slider dots at cursor position */}
      {showSlider && cursorX !== null && (
        <div style={{
          position: 'fixed',
          left: cursorX - DOT_SIZE / 2,
          top,
          display: 'flex', flexDirection: 'column', gap: DOT_GAP,
          alignItems: 'center', pointerEvents: 'none',
        }}>
          {HL_SLOTS.map((slot, i) => {
            const isPointing = dragStartY > 0
            const highlighted = i === displayIdx
            const dotColor = slot.id === 'draw' ? penColor : slot.color
            const isToolSlot = !!slot.svgIcon
            const dotW = isPointing && highlighted ? DOT_SIZE + 6 : DOT_SIZE
            return <div key={slot.id} style={{
              position: 'relative',
              width: dotW, height: dotW,
              borderRadius: '50%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxSizing: 'border-box',
              transition: 'all 0.08s',
              opacity: isPointing ? (highlighted ? 0.9 : 0.25) : 0.12,
              // Color slots: filled circle; tool slots: ring
              background: isToolSlot ? 'none' : dotColor,
              boxShadow: isToolSlot ? `inset 0 0 0 1.5px ${dotColor}` : 'none',
            }}>
              {/* Icon — color slots: white overlay-blended; tool slots: colored */}
              <span style={{
                display: 'block',
                width: dotW * 0.7, height: dotW * 0.7,
                WebkitMaskImage: `url("${slot.svgIcon ?? `${TLDRAW_ICON_BASE}#tool-highlight`}")`,
                maskImage: `url("${slot.svgIcon ?? `${TLDRAW_ICON_BASE}#tool-highlight`}")`,
                WebkitMaskSize: '100%', maskSize: '100%',
                WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat',
                WebkitMaskPosition: 'center', maskPosition: 'center',
                backgroundColor: isToolSlot ? dotColor : 'white',
                mixBlendMode: isToolSlot ? 'normal' : 'overlay',
                opacity: isToolSlot ? 1 : 0.8,
              }} />
            </div>
          })}
        </div>
      )}
      {/* HUD is rendered by the shared ToolNameHud component (mounted in
          SvgDocument). The toolNameHud bus is driven from the effect below. */}
    </div>
  )
}
