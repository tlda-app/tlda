import { useState, useEffect, useRef, useCallback } from 'react'
import {
  useEditor,
  useValue,
  TldrawUiMenuToolItem,
  useTools,
  useIsToolSelected,
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

export function PenHelperButtons({ format }: { format?: string }) {
  return (
    <>
      <ExitPenModeButton />
      <ToolToggleZones format={format} />
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
