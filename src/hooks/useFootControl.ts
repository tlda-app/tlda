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

    const foot = createFootController(editor)
    const click = createClickDetector()
    footRef.current = foot
    clickRef.current = click

    // Track mouse position + last-moved source for click routing
    let mouseX = window.innerWidth / 2
    let mouseY = window.innerHeight / 2
    let lastHandMove = 0
    let lastFootMove = 0
    const onMouseMove = (e: MouseEvent) => { mouseX = e.clientX; mouseY = e.clientY; lastHandMove = performance.now() }
    window.addEventListener('mousemove', onMouseMove, { passive: true })

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

    // Visible arrow cursor — shows heading direction, rotates as heading changes
    const cursorEl = document.createElement('div')
    cursorEl.style.cssText = `
      position: fixed; pointer-events: none; z-index: 99998;
      width: 28px; height: 28px;
      transform-origin: center center;
    `
    cursorEl.innerHTML = `
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
        <filter id="fc-shadow">
          <feDropShadow dx="0" dy="1" stdDeviation="1" flood-opacity="0.3"/>
        </filter>
        <g filter="url(#fc-shadow)">
          <polygon points="14,3 22,22 14,18 6,22" fill="rgba(139,92,246,0.7)" stroke="white" stroke-width="1.5" stroke-linejoin="round"/>
        </g>
      </svg>
    `
    cursorEl.style.opacity = '0.15'
    cursorEl.style.transition = 'opacity 0.4s ease'
    document.body.appendChild(cursorEl)

    let idleTimer: ReturnType<typeof setTimeout> | null = null
    foot.onStateChange(s => {
      const deg = s.heading * 180 / Math.PI + 90  // SVG arrow points up by default
      cursorEl.style.left = (s.cursorX - 14) + 'px'
      cursorEl.style.top = (s.cursorY - 14) + 'px'
      cursorEl.style.transform = `rotate(${deg}deg)`

      const isMoving = Math.abs(s.rudderAxis) > 0.05 || Math.abs(s.cursorAxis) > 0.05 || Math.abs(s.panAxis) > 0.05
      if (isMoving) {
        lastFootMove = performance.now()
        cursorEl.style.opacity = '0.5'
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
        idleTimer = setTimeout(() => { cursorEl.style.opacity = '0.15' }, 600)
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

    foot.start()
    click.start().catch(err => console.warn('[foot-control] mic access denied:', err))

    return () => {
      foot.stop()
      click.stop()
      offClick(); offDbl(); offEnter()
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      if (idleTimer) clearTimeout(idleTimer)
      if (spacePendingTimer) clearTimeout(spacePendingTimer)
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

function dispatchClick(editor: Editor, x: number, y: number, isDown: boolean) {
  if (!isDown) {
    // On pointer_up: check if something interactive is at the click position
    const el = document.elementFromPoint(x, y)
    if (isInteractiveHtml(el)) {
      // Use DOM events for HTML interactive elements (HUD buttons, inputs, etc.)
      ;(el as HTMLElement).focus?.()
      ;(el as HTMLElement).click?.()
      return
    }
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

function dispatchEnter(editor: Editor, x: number, y: number) {
  const target = getTarget(editor, x, y)
  const focused = document.activeElement

  const dispatchTarget = (isTextInput(focused) ? focused : isTextInput(target) ? target : document.body) as Element
  dispatchTarget.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }))
  dispatchTarget.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }))
}
