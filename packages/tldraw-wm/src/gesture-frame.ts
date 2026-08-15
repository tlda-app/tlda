import type { Editor, TLViewportId } from 'tldraw'
import { clientPointToPage } from './viewport-coordinates.ts'

export interface GestureFrameSelectors {
	viewportRoot?: (viewportId: string) => string
	viewportCanvas?: string
	elementChainStopClass?: string
}

function getGestureViewportElement(viewportId: string, selectors: GestureFrameSelectors = {}): HTMLElement | null {
	const rootSelector = selectors.viewportRoot?.(viewportId)
	if (!rootSelector) return null
	const root = document.querySelector(rootSelector)
	const el = selectors.viewportCanvas ? root?.querySelector(selectors.viewportCanvas) : root
	return el instanceof HTMLElement ? el : null
}

export function getGestureViewportCamera(editor: Editor, viewportId?: string): { x: number; y: number; z: number } {
  if (viewportId) {
    try { return editor.getViewport(viewportId as any).camera } catch { /* fall through */ }
  }
  return editor.getCamera()
}

export function getGestureViewportContainer(
	editor: Editor,
	viewportId?: string,
	selectors: GestureFrameSelectors = {},
): HTMLElement {
  if (viewportId) {
    const el = getGestureViewportElement(viewportId, selectors)
    if (el) return el as HTMLElement
  }
  return editor.getContainer()
}

export function screenPointToFramePage(
	overlay: Editor,
	clientX: number,
	clientY: number,
	options: { viewportId?: string; selectors?: GestureFrameSelectors } = {},
) {
	const { viewportId } = options
  return clientPointToPage(overlay, { x: clientX, y: clientY }, viewportId as TLViewportId | undefined)
}

export function describeElement(el: Element | null) {
  if (!el) return null
  let pointerEvents: string | null = null
  try {
    pointerEvents = window.getComputedStyle(el).pointerEvents
  } catch {
    pointerEvents = null
  }
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    classes: el instanceof HTMLElement || el instanceof SVGElement ? Array.from(el.classList).slice(0, 8) : [],
    shapeId: el.getAttribute('data-shape-id') || undefined,
    shapeType: el.getAttribute('data-shape-type') || undefined,
    role: el.getAttribute('role') || undefined,
    pointerEvents,
  }
}

export function elementChainAt(clientX: number, clientY: number, selectors: GestureFrameSelectors = {}) {
	const stopClass = selectors.elementChainStopClass
  const first = document.elementFromPoint(clientX, clientY)
  const chain: ReturnType<typeof describeElement>[] = []
  let cur: Element | null = first
  for (let i = 0; cur && i < 10; i++) {
    chain.push(describeElement(cur))
    if (stopClass && cur.classList.contains(stopClass)) break
    cur = cur.parentElement
  }
  return chain
}

export function cornerControlAtPoint(clientX: number, clientY: number, selector: string): Element | null {
  const el = document.elementFromPoint(clientX, clientY)
  return el?.closest?.(selector) ?? null
}
