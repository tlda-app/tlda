/**
 * useClickActions — wire tongue-click / lip-pop detection to tldraw editor actions.
 *
 * Starts the click detector on mount. While active:
 *   - Single tongue click → click at current cursor position
 *   - Double tongue click → context-sensitive (Enter in text field, drag-start on shape, dblclick elsewhere)
 *   - Lip pop → Enter at current cursor/focus position
 *
 * Requires mic permission — silently does nothing if denied.
 */

import { useEffect } from 'react'
import type { Editor } from 'tldraw'
import { createClickDetector } from '../clickDetect'

// Track real mouse position + last movement time globally.
let _mouseX = window.innerWidth / 2
let _mouseY = window.innerHeight / 2
let _lastMoveTime = 0
const STILLNESS_MS = 250  // cursor must be still for this long before a click registers
document.addEventListener('mousemove', (e) => {
  _mouseX = e.clientX; _mouseY = e.clientY; _lastMoveTime = performance.now()
}, { passive: true })

export function useClickActions(editor: Editor) {
  useEffect(() => {
    const cd = createClickDetector()

    const isCursorStill = () => performance.now() - _lastMoveTime > STILLNESS_MS

    cd.on('click', () => {
      if (!isCursorStill()) return
      flashAt(_mouseX, _mouseY, '#60a5fa')
      dispatchPointerClick(editor, _mouseX, _mouseY)
    })

    cd.on('dblclick', () => {
      if (!isCursorStill()) return
      flashAt(_mouseX, _mouseY, '#a78bfa')
      dispatchContextualDblClick(editor, _mouseX, _mouseY)
    })

    cd.on('enter', () => {
      if (!isCursorStill()) return
      flashAt(_mouseX, _mouseY, '#34d399')
      dispatchEnter(editor, _mouseX, _mouseY)
    })

    cd.start().catch(err => {
      console.warn('[click-detect] mic unavailable:', err)
    })

    return () => cd.stop()
  }, [editor])
}

function dispatchPointerClick(editor: Editor, x: number, y: number) {
  const canvas = editor.getContainer()
  canvas.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, cancelable: true,
    clientX: x, clientY: y,
    pointerType: 'mouse', isPrimary: true, pointerId: 1,
    button: 0, buttons: 1,
  }))
  canvas.dispatchEvent(new PointerEvent('pointerup', {
    bubbles: true, cancelable: true,
    clientX: x, clientY: y,
    pointerType: 'mouse', isPrimary: true, pointerId: 1,
    button: 0, buttons: 0,
  }))
  canvas.dispatchEvent(new MouseEvent('click', {
    bubbles: true, cancelable: true,
    clientX: x, clientY: y,
    button: 0, buttons: 0,
  }))
}

function dispatchContextualDblClick(editor: Editor, x: number, y: number) {
  const target = document.elementFromPoint(x, y)
  const canvas = editor.getContainer()

  if (isTextInput(target)) {
    target!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }))
    target!.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }))
    return
  }

  const pagePoint = editor.screenToPage({ x, y })
  const shape = editor.getShapeAtPoint(pagePoint)
  if (shape) {
    // Start a drag — pointerdown without pointerup; next single click = drop
    canvas.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true,
      clientX: x, clientY: y,
      pointerType: 'mouse', isPrimary: true, pointerId: 1,
      button: 0, buttons: 1,
    }))
    return
  }

  canvas.dispatchEvent(new MouseEvent('dblclick', {
    bubbles: true, cancelable: true,
    clientX: x, clientY: y,
    button: 0, buttons: 0,
  }))
}

function dispatchEnter(editor: Editor, x: number, y: number) {
  const focused = document.activeElement
  const target = document.elementFromPoint(x, y)
  const el = (isTextInput(focused) ? focused : isTextInput(target) ? target : document.body) as Element
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }))
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }))
}

/** Brief colored ripple at (x, y) in viewport coordinates. */
function flashAt(x: number, y: number, color: string) {
  const el = document.createElement('div')
  el.style.cssText = `
    position: fixed;
    left: ${x - 12}px;
    top: ${y - 12}px;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    background: ${color};
    opacity: 0.7;
    pointer-events: none;
    z-index: 99999;
    animation: click-flash 350ms ease-out forwards;
  `
  // Inject keyframes once
  if (!document.getElementById('click-flash-style')) {
    const s = document.createElement('style')
    s.id = 'click-flash-style'
    s.textContent = `@keyframes click-flash { 0%{transform:scale(0.3);opacity:0.7} 100%{transform:scale(2);opacity:0} }`
    document.head.appendChild(s)
  }
  document.body.appendChild(el)
  el.addEventListener('animationend', () => el.remove())
}

function isTextInput(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea') return true
  if ((el as HTMLElement).isContentEditable) return true
  return false
}
