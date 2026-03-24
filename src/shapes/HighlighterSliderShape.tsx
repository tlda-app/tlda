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
import { useState, useRef, useLayoutEffect } from 'react'
import {
  useEditor,
  useValue,
  DefaultColorStyle,
} from 'tldraw'

const TLDRAW_ICON_BASE = 'https://cdn.tldraw.com/4.3.1/icons/icon/0_merged.svg'

const highlightColors: Record<string, string> = {
  black: '#1d1d1d', grey: '#9fa1a4', 'light-violet': '#e0d4f5',
  violet: '#c77cff', blue: '#4ea2e2', 'light-blue': '#b7d9f5',
  yellow: '#ffc940', orange: '#ff8c40', green: '#65c365',
  'light-green': '#c5e8c5', 'light-red': '#f5c5c5', red: '#ff6b6b',
}

const HL_SLOTS: { id: string; color: string; label: string; svgIcon?: string }[] = [
  { id: 'eraser', color: '#888', label: 'eraser', svgIcon: `${TLDRAW_ICON_BASE}#tool-eraser` },
  { id: 'light-red', color: '#dc2626', label: 'wrong' },
  { id: 'orange', color: '#ff8c40', label: 'cite/prove' },
  { id: 'yellow', color: '#ffc940', label: 'explain' },
  { id: 'light-blue', color: '#4ea2e2', label: 'notation' },
  { id: 'light-green', color: '#65c365', label: 'approve' },
  { id: 'select', color: '#666', label: 'browse', svgIcon: `${TLDRAW_ICON_BASE}#tool-pointer` },
  { id: 'draw', color: '#666', label: 'pen', svgIcon: `${TLDRAW_ICON_BASE}#tool-pencil` },
]

const isTouch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
const DOT_SIZE = 14
const DOT_GAP = 6

export function HighlighterSlider() {
  // Hide in embed mode (fleet shared doc iframe)
  const isEmbed = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('embed')
  const editor = useEditor()
  const isPenMode = useValue('is pen mode', () => editor.getInstanceState().isPenMode, [editor])
  const penColor = useValue('pen color', () => {
    const colorName = (editor.getInstanceState().stylesForNextShape?.['tldraw:color'] as string) || 'black'
    return highlightColors[colorName] || '#1d1d1d'
  }, [editor])

  const [activeIdx, setActiveIdx] = useState(3)
  const [cursorY, setCursorY] = useState<number | null>(null)
  const [cursorX, setCursorX] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [dragStartY, setDragStartY] = useState(0)
  const lastTapTime = useRef(0)

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

  // On touch devices, only show in pen mode
  if (isEmbed) return null
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
    setActiveIdx(idx)
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
      style={{
        position: 'absolute', right: 0, top: tocBottom || '10%', bottom: '10%', width: 250,
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
            return <div key={slot.id} style={{
              width: isPointing && highlighted ? DOT_SIZE + 6 : DOT_SIZE,
              height: isPointing && highlighted ? DOT_SIZE + 6 : DOT_SIZE,
              borderRadius: '50%',
              background: slot.svgIcon ? 'transparent' : dotColor,
              opacity: isPointing ? (highlighted ? 0.9 : 0.25) : 0.12,
              transition: 'all 0.08s',
              border: i === activeIdx ? `2px solid ${dotColor}` : '2px solid transparent',
              boxSizing: 'border-box',
              ...(slot.svgIcon ? {
                WebkitMaskImage: `url("${slot.svgIcon}")`,
                maskImage: `url("${slot.svgIcon}")`,
                WebkitMaskSize: '70%', maskSize: '70%',
                WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat',
                WebkitMaskPosition: 'center', maskPosition: 'center',
                backgroundColor: dotColor,
              } : {}),
            }} />
          })}
        </div>
      )}
      {/* HUD at top-center */}
      {(dragStartY > 0) && (() => {
        const slot = HL_SLOTS[displayIdx]
        const hudColor = slot?.id === 'draw' ? penColor : (slot?.color || '#888')
        return <div style={{
          position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)',
          background: hudColor, color: '#fff',
          padding: '4px 14px', borderRadius: 12, fontSize: 12, fontWeight: 500,
          opacity: 0.85, pointerEvents: 'none', zIndex: 9999,
        }}>
          {slot?.label}
        </div>
      })()}
    </div>
  )
}
