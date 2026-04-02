/**
 * useFootControl — React hook integrating foot pedal control + click detection.
 *
 * Wires footControl.ts + clickDetect.ts to a tldraw editor:
 *   - Gamepads: cursor movement + camera pan via heading
 *   - Tongue click: click / dblclick (context-sensitive: drag-start on draggables, Enter in text fields)
 *   - Lip pop: Enter
 *
 * Enable/disable via the `enabled` option (e.g. behind a settings toggle).
 */

import { useEffect, useRef } from 'react'
import type { Editor } from 'tldraw'
import { DefaultColorStyle } from 'tldraw'
import { createFootController } from '../footControl'
import { createClickDetector } from '../clickDetect'

export interface UseFootControlOptions {
  enabled: boolean
}

export function useFootControl(editor: Editor | null, options: UseFootControlOptions) {
  const { enabled } = options
  const footRef = useRef<ReturnType<typeof createFootController> | null>(null)
  const clickRef = useRef<ReturnType<typeof createClickDetector> | null>(null)

  useEffect(() => {
    if (!enabled || !editor) return

    // Smart cursor move: route to HUD inner editor or main editor based on position
    const onCursorMove = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y)
      if (el?.closest('.fleet-hud-wrap, .clip-panel')) {
        // HUD inner editor — route via DOM events
        el.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true,
          clientX: x, clientY: y,
          pointerType: 'mouse', isPrimary: true, pointerId: 1,
          button: -1, buttons: 0,
        }))
      } else if (el?.closest('.tl-canvas')) {
        // Only dispatch to tldraw canvas when cursor is actually over the canvas,
        // not toolbar or other UI — prevents edge-scroll and tooltip jitter
        editor.dispatch({ type: 'pointer', target: 'canvas', name: 'pointer_move', ...tlPtr(x, y) })
      }
    }

    const foot = createFootController(editor, { onCursorMove })
    const click = createClickDetector()
    footRef.current = foot
    clickRef.current = click

    // Track mouse position + last-moved source for click routing
    let mouseX = window.innerWidth / 2
    let mouseY = window.innerHeight / 2
    let lastHandMove = 0
    let lastFootMove = 0
    // Intercept native pointermove in capture phase — fires before tldraw's handlers.
    // We handle the event ourselves (update foot cursor state) then stop propagation
    // so the native event never reaches tldraw. All cursor state in tldraw comes from
    // our editor.dispatch() calls only, eliminating the position mismatch.
    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return  // let touch/pen through
      mouseX = e.clientX; mouseY = e.clientY; lastHandMove = performance.now()
      foot.setCursorPos(e.clientX, e.clientY)
      e.stopPropagation()
    }
    window.addEventListener('pointermove', onPointerMove, { capture: true })

    // Route clicks to whichever cursor moved most recently
    const clickX = () => lastFootMove >= lastHandMove ? foot.state.cursorX : mouseX
    const clickY = () => lastFootMove >= lastHandMove ? foot.state.cursorY : mouseY

    // Drag state: double-click starts drag, single click drops
    let isDragging = false      // tldraw shape drag via editor.dispatch
    let isDomDragging = false   // HTML element drag via DOM pointer events

    // Wire click events to tldraw
    const offClick = click.on('click', () => {
      const x = clickX(), y = clickY()
      if (isDomDragging) {
        console.log('[foot-control] dom-drop at', x, y, '— dispatching pointerup to document')
        flashAt(x, y, '#f97316')
        document.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, clientX: x, clientY: y,
          pointerType: 'mouse', isPrimary: true, pointerId: 1, button: 0, buttons: 0,
        }))
        isDomDragging = false
        return
      }
      if (isDragging) {
        // Drop: send pointer_up to release the tldraw drag
        console.log('[foot-control] drop at', x, y)
        flashAt(x, y, '#f97316')
        dispatchPointerMove(editor, x, y)
        editor.dispatch({ type: 'pointer', target: 'canvas', name: 'pointer_up', ...tlPtr(x, y) })
        isDragging = false
        return
      }
      console.log('[foot-control] click at', x, y)
      flashAt(x, y, '#60a5fa')
      dispatchPointerMove(editor, x, y)
      dispatchClick(editor, x, y, true)
      dispatchClick(editor, x, y, false)
    })
    const offDbl = click.on('dblclick', () => {
      const x = clickX(), y = clickY()
      flashAt(x, y, '#a78bfa')
      dispatchPointerMove(editor, x, y)
      const pagePoint = editor.screenToPage({ x, y })
      const shape = editor.getShapeAtPoint(pagePoint) ?? editor.getShapeAtPoint(pagePoint, { hitInside: true, margin: 0 })
      console.log('[foot-control] dblclick at', x, y, '→ shape:', shape?.type, shape?.id)
      const dragResult = dispatchContextualDblClick(editor, x, y)
      isDragging = dragResult === 'tldraw'
      isDomDragging = dragResult === 'dom'
      console.log('[foot-control] drag:', dragResult)
    })
    const offEnter = click.on('enter', () => {
      const x = clickX(), y = clickY()
      flashAt(x, y, '#34d399')
      dispatchEnter(editor, x, y)
    })

    // Tapering ray — cone that narrows to nothing in the heading direction
    const rayEl = document.createElement('div')
    rayEl.style.cssText = `
      position: fixed; pointer-events: none; z-index: 99997;
      width: 350px; height: 16px;
      transform-origin: 0 50%;
      opacity: 0.15;
      transition: opacity 0.4s ease;
    `
    rayEl.innerHTML = `
      <svg width="350" height="16" viewBox="0 0 350 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="fc-ray-fade" x1="0" y1="0" x2="350" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stop-color="rgb(139,92,246)" stop-opacity="0.55"/>
            <stop offset="50%" stop-color="rgb(139,92,246)" stop-opacity="0.15"/>
            <stop offset="100%" stop-color="rgb(139,92,246)" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <polygon points="0,3 350,8 0,13" fill="url(#fc-ray-fade)"/>
      </svg>
    `
    document.body.appendChild(rayEl)

    // Custom cursor element — mirrors current tldraw cursor shape
    const cursorEl = document.createElement('div')
    cursorEl.style.cssText = `
      position: fixed; pointer-events: none; z-index: 99999;
      opacity: 0.15;
      transition: opacity 0.4s ease;
    `
    document.body.appendChild(cursorEl)

    // tldraw container — we read --tl-cursor from computed style (unaffected by cursor: none override)
    const tldrawContainerEl = document.querySelector('.tl-container') as HTMLElement | null

    let idleTimer: ReturnType<typeof setTimeout> | null = null
    foot.onStateChange(s => {
      const deg = s.heading * 180 / Math.PI
      rayEl.style.left = s.cursorX + 'px'
      rayEl.style.top = (s.cursorY - 8) + 'px'
      rayEl.style.transform = `rotate(${deg + 180}deg)`

      // Update cursor element to mirror tldraw's current cursor
      updateCursorEl(cursorEl, tldrawContainerEl, s.cursorX, s.cursorY)

      // Update tail color to match current tool color
      const color = getToolColor(editor)
      const stops = rayEl.querySelectorAll('stop') as NodeListOf<SVGStopElement>
      stops.forEach(stop => { stop.style.stopColor = color })

      const isMoving = Math.abs(s.rudderAxis) > 0.05 || Math.abs(s.cursorAxis) > 0.05 || Math.abs(s.panAxis) > 0.05
      if (isMoving) {
        lastFootMove = performance.now()
        rayEl.style.opacity = '0.85'
        cursorEl.style.opacity = '1'
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
        idleTimer = setTimeout(() => { rayEl.style.opacity = '0.15'; cursorEl.style.opacity = '0.15' }, 600)
        // Feed pointermove to document for DOM drag handlers (e.g. agent labels)
        if (isDomDragging) {
          document.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true, clientX: s.cursorX, clientY: s.cursorY,
            pointerType: 'mouse', isPrimary: true, pointerId: 1, button: 0, buttons: 1,
          }))
        }
      }
    })

    // Space = sim click, double-Space = sim dblclick/drag-start (for testing)
    // First Space waits 400ms for a second; double-Space fires drag-start instead.
    let spacePendingTimer: ReturnType<typeof setTimeout> | null = null
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return
      const active = document.activeElement
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || (active as HTMLElement).isContentEditable)) return
      e.preventDefault()
      const x = clickX(), y = clickY()
      if (isDomDragging) {
        console.log('[foot-control] space-dom-drop at', x, y)
        flashAt(x, y, '#f97316')
        document.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, clientX: x, clientY: y,
          pointerType: 'mouse', isPrimary: true, pointerId: 1, button: 0, buttons: 0,
        }))
        isDomDragging = false
        return
      }
      if (isDragging) {
        console.log('[foot-control] space-drop at', x, y)
        flashAt(x, y, '#f97316')
        dispatchPointerMove(editor, x, y)
        editor.dispatch({ type: 'pointer', target: 'canvas', name: 'pointer_up', ...tlPtr(x, y) })
        isDragging = false
        return
      }
      if (spacePendingTimer !== null) {
        // Second Space within 400ms = double-Space drag-start
        clearTimeout(spacePendingTimer)
        spacePendingTimer = null
        console.log('[foot-control] double-space drag-start at', x, y)
        flashAt(x, y, '#a78bfa')
        dispatchPointerMove(editor, x, y)
        const dragResult = dispatchContextualDblClick(editor, x, y)
        isDragging = dragResult === 'tldraw'
        isDomDragging = dragResult === 'dom'
        console.log('[foot-control] drag:', dragResult)
        return
      }
      // First Space — wait to see if a second follows
      spacePendingTimer = setTimeout(() => {
        spacePendingTimer = null
        console.log('[foot-control] space-click at', x, y)
        flashAt(x, y, '#f59e0b')
        dispatchPointerMove(editor, x, y)
        dispatchClick(editor, x, y, true)
        dispatchClick(editor, x, y, false)
      }, 400)
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })

    // Hide all cursors — the meteor is the only cursor indicator in foot mode
    const cursorStyle = document.createElement('style')
    cursorStyle.id = 'fc-cursor-hide'
    cursorStyle.textContent = '*, *::before, *::after { cursor: none !important; }'
    document.head.appendChild(cursorStyle)

    foot.start()
    click.start().catch(err => console.warn('[foot-control] mic access denied:', err))

    return () => {
      cursorStyle.remove()
      foot.stop()
      click.stop()
      offClick(); offDbl(); offEnter()
      window.removeEventListener('pointermove', onPointerMove, { capture: true })
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      if (idleTimer) clearTimeout(idleTimer)
      if (spacePendingTimer) clearTimeout(spacePendingTimer)
      rayEl.remove()
      cursorEl.remove()
      footRef.current = null
      clickRef.current = null
    }
  }, [enabled, editor])
}

function flashAt(x: number, y: number, color: string) {
  const el = document.createElement('div')
  el.style.cssText = `position:fixed;left:${x-12}px;top:${y-12}px;width:24px;height:24px;border-radius:50%;background:${color};opacity:0.7;pointer-events:none;z-index:99999;animation:fc-flash 350ms ease-out forwards;`
  if (!document.getElementById('fc-flash-style')) {
    const s = document.createElement('style')
    s.id = 'fc-flash-style'
    s.textContent = `@keyframes fc-flash{0%{transform:scale(0.3);opacity:0.7}100%{transform:scale(2);opacity:0}}`
    document.head.appendChild(s)
  }
  document.body.appendChild(el)
  el.addEventListener('animationend', () => el.remove())
}

// Map tldraw color names to CSS colors for the tail indicator
const TLDRAW_COLOR_CSS: Record<string, string> = {
  black: '#1d1d1d', grey: '#9b9b9b', white: '#f9f9f9',
  red: '#e03131', 'light-red': '#ff9b9b',
  orange: '#e67c00', 'light-orange': '#ffa94d',
  yellow: '#f4b400',
  green: '#099268', 'light-green': '#62df64',
  blue: '#4465e9', 'light-blue': '#7ac3f4',
  violet: '#7b5ea7', 'light-violet': '#b4a0ff',
}

function getToolColor(editor: Editor): string {
  try {
    const name = editor.getStyleForNextShape(DefaultColorStyle)
    return TLDRAW_COLOR_CSS[name] ?? '#9b9b9b'
  } catch {
    return '#9b9b9b'
  }
}

function getTarget(editor: Editor, x: number, y: number): Element | null {
  return document.elementFromPoint(x, y)
}

function isTextInput(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea') return true
  if ((el as HTMLElement).isContentEditable) return true
  return false
}

function isDraggableShape(editor: Editor, x: number, y: number): boolean {
  // Check if there's a shape under the cursor that supports dragging
  const pagePoint = editor.screenToPage({ x, y })
  const shape = editor.getShapeAtPoint(pagePoint)
  return !!shape
}

/** Build tldraw pointer event info — replaces getPointerInfo without needing a real DOM event */
function tlPtr(x: number, y: number) {
  return {
    point: { x, y, z: 0.5 },
    shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, accelKey: false,
    pointerId: 1, button: 0, isPen: false,
  }
}

function dispatchPointerMove(editor: Editor, x: number, y: number) {
  editor.dispatch({ type: 'pointer', target: 'canvas', name: 'pointer_move', ...tlPtr(x, y) })
}

function isInteractiveHtml(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName.toLowerCase()
  if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'textarea' || tag === 'select') return true
  if ((el as HTMLElement).isContentEditable) return true
  // Check ancestors for interactive elements (e.g. divs acting as buttons)
  const role = el.getAttribute('role')
  if (role === 'button' || role === 'link' || role === 'textbox') return true
  return false
}

function isOverHud(x: number, y: number): boolean {
  return !!document.elementFromPoint(x, y)?.closest('.fleet-hud-wrap, .clip-panel')
}

function dispatchClick(editor: Editor, x: number, y: number, isDown: boolean) {
  const el = document.elementFromPoint(x, y)
  if (!isDown) {
    // On pointer_up: check if something interactive is at the click position
    if (isInteractiveHtml(el)) {
      // Use DOM events for HTML interactive elements (HUD buttons, inputs, etc.)
      ;(el as HTMLElement).focus?.()
      ;(el as HTMLElement).click?.()
      return
    }
    // Route to HUD inner editor via DOM events
    if (isOverHud(x, y)) {
      el?.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        pointerType: 'mouse', isPrimary: true, pointerId: 1, button: 0, buttons: 0,
      }))
      return
    }
  } else if (isOverHud(x, y)) {
    el?.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
      pointerType: 'mouse', isPrimary: true, pointerId: 1, button: 0, buttons: 1,
    }))
    return
  }
  editor.dispatch({ type: 'pointer', target: 'canvas', name: isDown ? 'pointer_down' : 'pointer_up', ...tlPtr(x, y) })
}

/** Returns 'tldraw' | 'dom' | false indicating what kind of drag was started */
function dispatchContextualDblClick(editor: Editor, x: number, y: number): 'tldraw' | 'dom' | false {
  const target = getTarget(editor, x, y)

  if (isTextInput(target)) {
    target?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }))
    target?.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }))
    return false
  }

  // Try DOM element first — catches React onPointerDown handlers (e.g. agent label spans)
  // that live inside tldraw shapes but handle their own drag
  const el = document.elementFromPoint(x, y)
  const isTldrawCanvas = el?.closest('.tl-canvas') && !el?.closest('[data-shape-id]')
  if (el && !isTldrawCanvas) {
    el.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, clientX: x, clientY: y,
      pointerType: 'mouse', isPrimary: true, pointerId: 1, button: 0, buttons: 1,
    }))
    // Kick off a small move to cross DRAG_THRESHOLD (5px) so the pill shape is created immediately
    document.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, clientX: x + 6, clientY: y,
      pointerType: 'mouse', isPrimary: true, pointerId: 1, button: 0, buttons: 1,
    }))
    return 'dom'
  }

  // Cursor is on bare tldraw canvas — use tldraw shape dispatch
  const pagePoint = editor.screenToPage({ x, y })
  const shape = editor.getShapeAtPoint(pagePoint) ?? editor.getShapeAtPoint(pagePoint, { hitInside: true, margin: 0 })
  if (shape) {
    editor.dispatch({ type: 'pointer', target: 'shape', shape, name: 'pointer_down', ...tlPtr(x, y) })
    return 'tldraw'
  }

  // Default: double-click on canvas
  editor.dispatch({ type: 'pointer', target: 'canvas', name: 'pointer_down', ...tlPtr(x, y) })
  editor.dispatch({ type: 'pointer', target: 'canvas', name: 'pointer_up', ...tlPtr(x, y) })
  editor.dispatch({ type: 'pointer', target: 'canvas', name: 'double_click', ...tlPtr(x, y) })
  return false
}

// ---------------------------------------------------------------------------
// Cursor emulation — mirrors tldraw's CSS cursor at the foot cursor position
// ---------------------------------------------------------------------------

const CURSOR_SVGS: Record<string, { svg: string; hx: number; hy: number }> = {
  default: {
    hx: 3, hy: 1,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="20" viewBox="0 0 16 20"><path d="M3 1 L3 15 L6 12 L8.5 17.5 L10.5 16.5 L8 11 L12 11 Z" fill="black" stroke="white" stroke-width="1" stroke-linejoin="round" paint-order="stroke"/></svg>`,
  },
  crosshair: {
    hx: 10, hy: 10,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><line x1="10" y1="1" x2="10" y2="8" stroke="black" stroke-width="1.5" stroke-linecap="round"/><line x1="10" y1="12" x2="10" y2="19" stroke="black" stroke-width="1.5" stroke-linecap="round"/><line x1="1" y1="10" x2="8" y2="10" stroke="black" stroke-width="1.5" stroke-linecap="round"/><line x1="12" y1="10" x2="19" y2="10" stroke="black" stroke-width="1.5" stroke-linecap="round"/><circle cx="10" cy="10" r="1.5" fill="black"/></svg>`,
  },
  pointer: {
    hx: 5, hy: 1,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="20" viewBox="0 0 14 20"><path d="M5 1 C4 1 3 2 3 3 L3 12 L1 10 C0 9 0 10 1 11 L5 16 C6 18 8 19 10 19 L11 19 C13 19 14 17 14 15 L14 9 C14 8 13 7 12 7 L11 7 L11 3 C11 2 10 1 9 1 L8 1 L8 3 C8 3 8 3 8 3 L8 3 C8 2 7 1 6 1 L5 1 Z" fill="black" stroke="white" stroke-width="0.5" paint-order="stroke"/></svg>`,
  },
  move: {
    hx: 10, hy: 10,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="M10 1 L7 5 L9 5 L9 11 L11 11 L11 5 L13 5 Z M10 19 L7 15 L9 15 L9 11 L11 11 L11 15 L13 15 Z M1 10 L5 7 L5 9 L9 9 L9 11 L5 11 L5 13 Z M19 10 L15 7 L15 9 L11 9 L11 11 L15 11 L15 13 Z" fill="black" stroke="white" stroke-width="0.5" paint-order="stroke"/></svg>`,
  },
  text: {
    hx: 4, hy: 9,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="18" viewBox="0 0 8 18"><line x1="4" y1="0" x2="4" y2="18" stroke="black" stroke-width="1.5"/><line x1="0" y1="0" x2="8" y2="0" stroke="black" stroke-width="1.5"/><line x1="0" y1="18" x2="8" y2="18" stroke="black" stroke-width="1.5"/></svg>`,
  },
  grab: {
    hx: 10, hy: 6,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="M7 4 C7 3 6 2 5 2 C4 2 3 3 3 4 L3 11 M7 4 C7 3 8 2 9 2 C10 2 11 3 11 4 L11 9 M11 9 C11 8 12 7 13 7 C14 7 15 8 15 9 L15 13 C15 16 13 18 10 18 L8 18 C5 18 3 16 3 13 L3 11" fill="none" stroke="black" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 4 L7 9 M9 3 L9 9" fill="none" stroke="black" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  },
  grabbing: {
    hx: 10, hy: 10,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="M5 9 C5 8 6 7 7 7 L13 7 C14 7 15 8 15 9 L15 13 C15 16 13 18 10 18 L8 18 C5 18 3 16 3 13 L3 9 C3 8 4 7 5 7 Z" fill="black" stroke="white" stroke-width="0.5" paint-order="stroke"/></svg>`,
  },
  'ew-resize': {
    hx: 10, hy: 6,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="12" viewBox="0 0 20 12"><path d="M1 6 L5 2 L5 5 L15 5 L15 2 L19 6 L15 10 L15 7 L5 7 L5 10 Z" fill="black" stroke="white" stroke-width="0.5" paint-order="stroke"/></svg>`,
  },
  'ns-resize': {
    hx: 6, hy: 10,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="20" viewBox="0 0 12 20"><path d="M6 1 L2 5 L5 5 L5 15 L2 15 L6 19 L10 15 L7 15 L7 5 L10 5 Z" fill="black" stroke="white" stroke-width="0.5" paint-order="stroke"/></svg>`,
  },
  'nwse-resize': {
    hx: 10, hy: 10,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="M2 2 L9 2 L7 4 L14 11 L16 9 L16 16 L9 16 L11 14 L4 7 L2 9 Z" fill="black" stroke="white" stroke-width="0.5" paint-order="stroke"/></svg>`,
  },
  'nesw-resize': {
    hx: 10, hy: 10,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20"><path d="M18 2 L11 2 L13 4 L6 11 L4 9 L4 16 L11 16 L9 14 L16 7 L18 9 Z" fill="black" stroke="white" stroke-width="0.5" paint-order="stroke"/></svg>`,
  },
}

function parseTlCursor(cursorVal: string): { src: string; hx: number; hy: number } | null {
  // tldraw cursor values look like: url("data:image/svg+xml,...") 12 8, default
  // Handle double-quoted URL
  const dbl = cursorVal.match(/url\("(data:[^"]+)"\)\s+(\d+)\s+(\d+)/)
  if (dbl) return { src: dbl[1], hx: parseInt(dbl[2]), hy: parseInt(dbl[3]) }
  // Handle single-quoted URL
  const sgl = cursorVal.match(/url\('(data:[^']+)'\)\s+(\d+)\s+(\d+)/)
  if (sgl) return { src: sgl[1], hx: parseInt(sgl[2]), hy: parseInt(sgl[3]) }
  // Unquoted
  const unq = cursorVal.match(/url\((data:[^\s)]+)\)\s+(\d+)\s+(\d+)/)
  if (unq) return { src: unq[1], hx: parseInt(unq[2]), hy: parseInt(unq[3]) }
  return null
}

let _cursorImgEl: HTMLImageElement | null = null
let _cursorLastSrc = ''

function updateCursorEl(cursorEl: HTMLElement, containerEl: HTMLElement | null, x: number, y: number) {
  // Read tldraw's --tl-cursor custom property — resolves to full cursor spec.
  // getPropertyValue reads the CSS variable even when cursor: none !important is in effect.
  const tlCursorVal = containerEl
    ? getComputedStyle(containerEl).getPropertyValue('--tl-cursor').trim()
    : ''

  const parsed = parseTlCursor(tlCursorVal)

  let src: string
  let hx: number, hy: number

  if (parsed) {
    // Re-encode the data URI for use as img src.
    // tldraw's SVG is partially encoded (%23 for #, but unencoded < > ')
    // and may contain bare % (e.g. "180%") — use a safe per-sequence decoder.
    const svgContent = parsed.src.replace(/^data:image\/svg\+xml,/, '')
    const svgDecoded = svgContent.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    src = 'data:image/svg+xml,' + encodeURIComponent(svgDecoded)
    hx = parsed.hx
    hy = parsed.hy
  } else {
    // Fall back to our hand-drawn default arrow
    const entry = CURSOR_SVGS.default
    src = 'data:image/svg+xml,' + encodeURIComponent(entry.svg)
    hx = entry.hx; hy = entry.hy
  }

  cursorEl.style.left = (x - hx) + 'px'
  cursorEl.style.top = (y - hy) + 'px'

  if (!_cursorImgEl || _cursorImgEl.parentElement !== cursorEl) {
    _cursorImgEl = document.createElement('img')
    _cursorImgEl.style.cssText = 'display:block;'
    cursorEl.innerHTML = ''
    cursorEl.appendChild(_cursorImgEl)
    _cursorLastSrc = ''
  }
  if (_cursorLastSrc !== src) {
    _cursorImgEl.src = src
    _cursorLastSrc = src
  }
}

function dispatchEnter(editor: Editor, x: number, y: number) {
  const target = getTarget(editor, x, y)
  const focused = document.activeElement

  const dispatchTarget = (isTextInput(focused) ? focused : isTextInput(target) ? target : document.body) as Element
  dispatchTarget.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }))
  dispatchTarget.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }))
}
