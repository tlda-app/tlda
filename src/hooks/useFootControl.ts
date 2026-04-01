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

    // Wire click events to tldraw
    const offClick = click.on('click', () => dispatchClick(editor, foot.state.cursorX, foot.state.cursorY, false))
    const offDbl = click.on('dblclick', () => dispatchContextualDblClick(editor, foot.state.cursorX, foot.state.cursorY))
    const offEnter = click.on('enter', () => dispatchEnter(editor, foot.state.cursorX, foot.state.cursorY))

    foot.start()
    click.start().catch(err => console.warn('[foot-control] mic access denied:', err))

    return () => {
      foot.stop()
      click.stop()
      offClick(); offDbl(); offEnter()
      footRef.current = null
      clickRef.current = null
    }
  }, [enabled, editor])
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

function dispatchClick(editor: Editor, x: number, y: number, isDown: boolean) {
  const canvas = editor.getContainer()
  const type = isDown ? 'pointerdown' : 'pointerup'
  canvas.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true,
    clientX: x, clientY: y,
    pointerType: 'mouse', isPrimary: true, pointerId: 1,
    button: 0, buttons: isDown ? 1 : 0,
  }))
  if (!isDown) {
    canvas.dispatchEvent(new PointerEvent('click', {
      bubbles: true, cancelable: true,
      clientX: x, clientY: y,
      pointerType: 'mouse', isPrimary: true, pointerId: 1,
      button: 0, buttons: 0,
    }))
  }
}

function dispatchContextualDblClick(editor: Editor, x: number, y: number) {
  const target = getTarget(editor, x, y)
  const canvas = editor.getContainer()

  if (isTextInput(target)) {
    // In a text field: dispatch Enter instead
    target?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }))
    target?.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }))
    return
  }

  if (isDraggableShape(editor, x, y)) {
    // On a shape: start a drag via pointerdown (tldraw will initiate drag on move)
    canvas.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true,
      clientX: x, clientY: y,
      pointerType: 'mouse', isPrimary: true, pointerId: 1,
      button: 0, buttons: 1,
    }))
    // Don't dispatch pointerup — foot controller will dispatch it on the next click
    return
  }

  // Default: real double-click
  canvas.dispatchEvent(new MouseEvent('dblclick', {
    bubbles: true, cancelable: true,
    clientX: x, clientY: y, button: 0, buttons: 0,
  }))
}

function dispatchEnter(editor: Editor, x: number, y: number) {
  const target = getTarget(editor, x, y)
  const focused = document.activeElement

  const dispatchTarget = (isTextInput(focused) ? focused : isTextInput(target) ? target : document.body) as Element
  dispatchTarget.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }))
  dispatchTarget.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' }))
}
