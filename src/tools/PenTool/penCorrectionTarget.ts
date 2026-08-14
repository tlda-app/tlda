import type { TLShapeId } from 'tldraw'

export const PEN_CORRECTION_EVENT = 'tlda-pen-correction'

export type PenCorrectionTarget = {
  shapeId: string
  messageId: string
  word: string | null
  inkShapeId?: string
}

type ResolvedPenCorrectionTarget = { row: HTMLElement; detail: PenCorrectionTarget }
type ScreenRect = { left: number; top: number; right: number; bottom: number }

export function resolvePenCorrectionTargetFromRect(ink: ScreenRect): ResolvedPenCorrectionTarget | null {
  if (typeof document === 'undefined') return null
  let best: { row: HTMLElement; overlap: number; area: number } | null = null
  for (const row of document.querySelectorAll<HTMLElement>('.fleet-chat-shape [data-msg-id]')) {
    const rect = row.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    const overlap = intersectionArea(ink, rect)
    if (overlap === 0 && !containsPoint(rect, ink.left, ink.top)) continue
    const area = rect.width * rect.height
    if (!best || overlap > best.overlap || (overlap === best.overlap && area < best.area)) {
      best = { row, overlap, area }
    }
  }
  if (!best) return null
  const shape = best.row.closest('.fleet-chat-shape')?.closest<HTMLElement>('[data-shape-id]')
  return {
    row: best.row,
    detail: {
      shapeId: shape?.dataset.shapeId ?? '',
      messageId: best.row.dataset.msgId ?? '',
      word: wordOverlappingRect(best.row, ink),
    },
  }
}

export function completePenCorrection(
  editor: {
    getCurrentPageShapeIds?(): ReadonlySet<TLShapeId>
    getShape?(id: TLShapeId): { type?: string } | undefined
    getShapePageBounds?(id: TLShapeId): { minX: number; minY: number; maxX: number; maxY: number } | undefined
    pageToScreen?(point: { x: number; y: number }): { x: number; y: number }
  },
  completeStroke: () => void,
): void {
  const before = editor.getCurrentPageShapeIds?.() ?? new Set<TLShapeId>()
  completeStroke()
  const inkShapeId = [...(editor.getCurrentPageShapeIds?.() ?? [])].find(id =>
    !before.has(id) && editor.getShape?.(id)?.type === 'draw'
  )
  if (!inkShapeId) return
  const bounds = editor.getShapePageBounds?.(inkShapeId)
  if (!bounds || !editor.pageToScreen) return
  const topLeft = editor.pageToScreen({ x: bounds.minX, y: bounds.minY })
  const bottomRight = editor.pageToScreen({ x: bounds.maxX, y: bounds.maxY })
  const target = resolvePenCorrectionTargetFromRect({
    left: Math.min(topLeft.x, bottomRight.x),
    top: Math.min(topLeft.y, bottomRight.y),
    right: Math.max(topLeft.x, bottomRight.x),
    bottom: Math.max(topLeft.y, bottomRight.y),
  })
  if (!target) return
  target.detail.inkShapeId = inkShapeId
  const EventConstructor = target.row.ownerDocument.defaultView?.CustomEvent ?? CustomEvent
  target.row.dispatchEvent(new EventConstructor(PEN_CORRECTION_EVENT, {
    bubbles: true,
    detail: target.detail,
  }))
}

function wordOverlappingRect(row: HTMLElement, ink: ScreenRect): string | null {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let best: { word: string; overlap: number } | null = null
  let node: Node | null
  while ((node = walker.nextNode())) {
    const text = node.textContent ?? ''
    for (const match of text.matchAll(/\S+/g)) {
      const start = match.index ?? 0
      range.setStart(node, start)
      range.setEnd(node, start + match[0].length)
      for (const rect of range.getClientRects()) {
        const overlap = intersectionArea(ink, rect)
        if (overlap > 0 && (!best || overlap > best.overlap)) best = { word: match[0], overlap }
        else if (overlap === 0 && containsPoint(rect, ink.left, ink.top) && !best) {
          best = { word: match[0], overlap: 0 }
        }
      }
    }
  }
  return best?.word ?? null
}

function intersectionArea(a: ScreenRect, b: ScreenRect): number {
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
}

function containsPoint(rect: ScreenRect, x: number, y: number): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
}
