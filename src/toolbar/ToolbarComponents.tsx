import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import {
  useEditor,
  useValue,
  TldrawUiMenuToolItem,
  useTools,
  useIsToolSelected,
  DefaultColorStyle,
} from 'tldraw'
import { getFormatConfig, homeTool, doubleTapTools } from '../formatConfig'

export function BrowseToolbarItem() {
  const tools = useTools()
  const isSelected = useIsToolSelected(tools['browse'])
  return <TldrawUiMenuToolItem toolId="browse" isSelected={isSelected} />
}

export function MathNoteToolbarItem() {
  const tools = useTools()
  const isSelected = useIsToolSelected(tools['math-note'])
  return <TldrawUiMenuToolItem toolId="math-note" isSelected={isSelected} />
}

export function TextSelectToolbarItem() {
  const tools = useTools()
  const isSelected = useIsToolSelected(tools['text-select'])
  return <TldrawUiMenuToolItem toolId="text-select" isSelected={isSelected} />
}

export function ExitPenModeButton() {
  const editor = useEditor()
  const isPenMode = useValue('is pen mode', () => editor.getInstanceState().isPenMode, [editor])
  if (!isPenMode) return null
  return (
    <button
      className="exit-pen-mode-btn"
      onClick={() => editor.updateInstanceState({ isPenMode: false })}
    >
      <span className="exit-pen-mode-stack">
        <span className="exit-pen-mode-pen">{'\u270F\uFE0E'}</span>
        <span className="exit-pen-mode-x">{'\u2715'}</span>
      </span>
    </button>
  )
}

// --- Tool toggle zones (pen-only, inside TLDraw tree) ---

const highlightColors: Record<string, string> = {
  black: '#1d1d1d', grey: '#9fa1a4', 'light-violet': '#e0d4f5',
  violet: '#c77cff', blue: '#4ea2e2', 'light-blue': '#b7d9f5',
  yellow: '#ffc940', orange: '#ff8c40', green: '#65c365',
  'light-green': '#c5e8c5', 'light-red': '#f5c5c5', red: '#ff6b6b',
}

const isTouch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

/**
 * ToolToggleZones — pen-mode-only touch targets for quick tool switching.
 * Reads double-tap targets from FormatConfig positions 1-3 (the three tools
 * after the home tool). Double-tapping the current tool returns to position 0.
 */
export function ToolToggleZones({ format }: { format?: string }) {
  const editor = useEditor()
  const isPenMode = useValue('is pen mode', () => editor.getInstanceState().isPenMode, [editor])
  const [currentTool, setCurrentTool] = useState(editor.getCurrentToolId())
  const [highlightColor, setHighlightColor] = useState('#c77cff')
  const lastTapRef = useRef<{ tool: string; time: number }>({ tool: '', time: 0 })
  const fmt = getFormatConfig(format)
  const home = homeTool(fmt)
  const zoneTools = doubleTapTools(fmt)

  // Track tool and color changes
  useEffect(() => {
    const update = () => {
      setCurrentTool(editor.getCurrentToolId())
      const colorName = (editor.getInstanceState().stylesForNextShape?.['tldraw:color'] as string) || 'violet'
      setHighlightColor(highlightColors[colorName] || '#c77cff')
    }
    editor.on('change', update)
    update()
    return () => { editor.off('change', update) }
  }, [editor])

  const handlePenEnter = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === 'pen') e.currentTarget.classList.add('pen-hover')
  }, [])
  const handlePenLeave = useCallback((e: React.PointerEvent) => {
    e.currentTarget.classList.remove('pen-hover')
  }, [])

  const handleDoubleTap = useCallback((targetTool: string) => (e: React.PointerEvent) => {
    if (e.pointerType !== 'pen') return
    e.preventDefault()
    e.stopPropagation()
    editor.markEventAsHandled(e)

    const now = Date.now()
    const last = lastTapRef.current
    if (last.tool === targetTool && now - last.time < 400) {
      const cur = editor.getCurrentToolId()
      // Double-tap current tool → return to home; double-tap different → switch to it
      editor.setCurrentTool(cur === targetTool ? home : targetTool)
      lastTapRef.current = { tool: '', time: 0 }
    } else {
      lastTapRef.current = { tool: targetTool, time: now }
    }
  }, [editor, home])

  // Only show on touch devices in pen mode
  if (!isTouch || !isPenMode) return null

  // Zones map to config positions 1-3 (the three tools after home)
  return (
    <div className="tool-toggle-zones">
      {zoneTools.map((toolId) => (
        <div
          key={toolId}
          className={`tool-toggle-zone tool-toggle-zone--${toolId} ${currentTool === toolId ? 'active' : ''}`}
          style={toolId === 'highlight' ? { '--zone-highlight-color': highlightColor } as React.CSSProperties : undefined}
          onPointerDown={handleDoubleTap(toolId)}
          onPointerEnter={handlePenEnter}
          onPointerLeave={handlePenLeave}
        >
          <div className={`tool-toggle-zone-icon tool-toggle-zone-icon--${toolId}`} />
        </div>
      ))}
    </div>
  )
}

/** Slider slots: eraser at top, colors in middle, pointer at bottom */
const TLDRAW_ICON_BASE = 'https://cdn.tldraw.com/4.3.1/icons/icon/0_merged.svg'
const HL_SLOTS: { id: string; color: string; label: string; svgIcon?: string }[] = [
  { id: 'eraser', color: '#888', label: 'eraser', svgIcon: `${TLDRAW_ICON_BASE}#tool-eraser` },
  { id: 'light-red', color: '#dc2626', label: 'wrong' },
  { id: 'orange', color: '#ff8c40', label: 'cite/prove' },
  { id: 'yellow', color: '#ffc940', label: 'explain' },
  { id: 'light-blue', color: '#4ea2e2', label: 'notation' },
  { id: 'light-green', color: '#65c365', label: 'approve' },
  { id: 'select', color: '#666', label: 'browse', svgIcon: `${TLDRAW_ICON_BASE}#tool-pointer` },
]

/**
 * DesktopHighlighterZone — invisible zone on the right edge.
 * Hover: ghost slider appears at cursor Y, centered on current color.
 * Drag: slider materializes, move up/down to pick. Double-tap: undo.
 * Desktop only (touch devices use PhoneHighlighterButton).
 */
export function DesktopHighlighterZone() {
  const editor = useEditor()
  const [activeIdx, setActiveIdx] = useState(3) // default: yellow
  const [mouseY, setMouseY] = useState<number | null>(null)
  const [mouseX, setMouseX] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [dragStartY, setDragStartY] = useState(0)
  const lastTapTime = useRef(0)
  const DOT_SIZE = 14
  const DOT_GAP = 6
  const SLIDER_HEIGHT = HL_SLOTS.length * (DOT_SIZE + DOT_GAP) - DOT_GAP

  // Don't render on touch devices
  if (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches) return null

  const activateSlot = useCallback((idx: number) => {
    const slot = HL_SLOTS[idx]
    if (slot.id === 'eraser') {
      editor.setCurrentTool('eraser')
    } else if (slot.id === 'select') {
      editor.setCurrentTool('select')
    } else {
      editor.setStyleForNextShapes(DefaultColorStyle, slot.id)
      editor.setCurrentTool('highlight')
    }
    setActiveIdx(idx)
  }, [editor])

  const undoLastHighlight = useCallback(() => {
    const shapes = editor.getCurrentPageShapes()
    const highlights = shapes
      .filter((s: any) => s.type === 'highlight')
      .sort((a: any, b: any) => (b.index || '').localeCompare(a.index || ''))
    if (highlights.length > 0) editor.deleteShape(highlights[0].id)
  }, [editor])

  // Slider top: position so activeIdx dot is at cursor Y
  const sliderTop = (cursorY: number, centerIdx: number) =>
    cursorY - centerIdx * (DOT_SIZE + DOT_GAP) - DOT_SIZE / 2

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const now = Date.now()
    if (now - lastTapTime.current < 400) {
      undoLastHighlight()
      lastTapTime.current = 0
      return
    }
    lastTapTime.current = now
    setDragStartY(e.clientY)
    setDragging(false)
    setDragIdx(null)
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [undoLastHighlight])

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    setMouseY(e.clientY)
    setMouseX(e.clientX)
    if (!dragging && dragStartY && Math.abs(e.clientY - dragStartY) > 6) {
      setDragging(true)
    }
    if (dragging) {
      // Which slot is the cursor on? Slider is centered on activeIdx at dragStartY.
      const top = sliderTop(dragStartY, activeIdx)
      const relY = e.clientY - top
      const idx = Math.max(0, Math.min(HL_SLOTS.length - 1, Math.floor(relY / (DOT_SIZE + DOT_GAP))))
      setDragIdx(idx)
    }
  }, [dragging, dragStartY, activeIdx])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
    if (dragging && dragIdx !== null) {
      activateSlot(dragIdx)
    } else if (!dragging) {
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
  }, [dragging, dragIdx, activeIdx, activateSlot, editor])

  const handlePointerLeave = useCallback(() => {
    if (!dragging) { setMouseY(null); setMouseX(null) }
  }, [dragging])

  // When dragging, lock slider at the position where drag started
  const cursorY = dragging ? dragStartY : mouseY
  const showSlider = cursorY !== null || dragging
  const top = cursorY ? sliderTop(cursorY, activeIdx) : 0
  const displayIdx = dragIdx ?? activeIdx

  return createPortal(
    <div
      className="desktop-hl-zone"
      onPointerEnter={(e) => { setMouseY(e.clientY); setMouseX(e.clientX) }}
      onPointerLeave={handlePointerLeave}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      style={{
        position: 'fixed', right: 0, top: '10%', bottom: '10%', width: 60,
        zIndex: 999, cursor: 'pointer',
      }}
    >
      {/* Slider at cursor Y, centered on current color */}
      {showSlider && (
        <div style={{
          position: 'fixed',
          right: 14,
          top,
          display: 'flex', flexDirection: 'column', gap: DOT_GAP,
          alignItems: 'center', pointerEvents: 'none',
        }}>
          {HL_SLOTS.map((slot, i) => (
            <div key={slot.id} style={{
              width: dragging && i === dragIdx ? DOT_SIZE + 6 : DOT_SIZE,
              height: dragging && i === dragIdx ? DOT_SIZE + 6 : DOT_SIZE,
              borderRadius: '50%',
              background: slot.svgIcon ? 'transparent' : slot.color,
              opacity: dragging ? (i === dragIdx ? 0.9 : 0.25) : 0.12,
              transition: 'all 0.08s',
              border: i === activeIdx ? `2px solid ${slot.color}` : '2px solid transparent',
              boxSizing: 'border-box',
              ...(slot.svgIcon ? {
                WebkitMaskImage: `url("${slot.svgIcon}")`,
                maskImage: `url("${slot.svgIcon}")`,
                WebkitMaskSize: '70%', maskSize: '70%',
                WebkitMaskRepeat: 'no-repeat', maskRepeat: 'no-repeat',
                WebkitMaskPosition: 'center', maskPosition: 'center',
                backgroundColor: slot.color,
              } : {}),
            }} />
          ))}
        </div>
      )}
      {/* HUD at top-center during drag */}
      {dragging && dragIdx !== null && (
        <div style={{
          position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)',
          background: HL_SLOTS[dragIdx]?.color || '#888', color: '#fff',
          padding: '4px 14px', borderRadius: 12, fontSize: 12, fontWeight: 500,
          opacity: 0.85, pointerEvents: 'none', zIndex: 9999,
        }}>
          {HL_SLOTS[dragIdx]?.label}
        </div>
      )}
    </div>,
    document.body
  )
}

export function PenHelperButtons({ format }: { format?: string }) {
  return (
    <>
      <ExitPenModeButton />
      <ToolToggleZones format={format} />
      <DesktopHighlighterZone />
    </>
  )
}

/** Sync TLDraw dark mode to <html data-theme> for portaled elements */
export function DarkModeSync() {
  const editor = useEditor()
  const isDark = useValue('isDarkMode', () => editor.user.getIsDarkMode(), [editor])
  useEffect(() => {
    globalThis.document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light')
  }, [isDark])
  return null
}
