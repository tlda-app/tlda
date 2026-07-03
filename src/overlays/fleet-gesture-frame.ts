import type { Editor } from 'tldraw'

export function getGestureViewportCamera(editor: Editor, viewportId?: string): { x: number; y: number; z: number } {
  if (viewportId) {
    try { return editor.getViewport(viewportId as any).camera } catch { /* fall through */ }
  }
  return editor.getCamera()
}

export function getGestureViewportContainer(editor: Editor, viewportId?: string): HTMLElement {
  if (viewportId) {
    const el = document.querySelector(`[data-viewport-id="${viewportId}"]`)?.querySelector('.clip-panel-canvas')
    if (el) return el as HTMLElement
  }
  return editor.getContainer()
}

export function screenPointToOverlayPage(overlay: Editor, clientX: number, clientY: number, viewportId?: string) {
  const container = viewportId
    ? document.querySelector(`[data-viewport-id="${viewportId}"]`)?.querySelector('.clip-panel-canvas') ?? getGestureViewportContainer(overlay, viewportId)
    : getGestureViewportContainer(overlay, viewportId)
  const rect = (container as HTMLElement).getBoundingClientRect()
  return overlay.screenToPage({ x: clientX - rect.left, y: clientY - rect.top }, viewportId ? { viewportId } : undefined)
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

export function elementChainAt(clientX: number, clientY: number, stopClass = 'fleet-hud-wrap') {
  const first = document.elementFromPoint(clientX, clientY)
  const chain: ReturnType<typeof describeElement>[] = []
  let cur: Element | null = first
  for (let i = 0; cur && i < 10; i++) {
    chain.push(describeElement(cur))
    if (cur.classList.contains(stopClass)) break
    cur = cur.parentElement
  }
  return chain
}

export function cornerControlAtPoint(clientX: number, clientY: number, selector: string): Element | null {
  const el = document.elementFromPoint(clientX, clientY)
  return el?.closest?.(selector) ?? null
}
