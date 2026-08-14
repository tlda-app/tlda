import type { TLShapeId } from 'tldraw'

export const PEN_CORRECTION_EVENT = 'tlda-pen-correction'

export type PenCorrectionTarget = {
  shapeId: string
  messageId: string
  word: string | null
  inkShapeId?: string
}

type ResolvedPenCorrectionTarget = { row: HTMLElement; detail: PenCorrectionTarget }

export function resolvePenCorrectionTarget(x: number, y: number): ResolvedPenCorrectionTarget | null {
  if (typeof document === 'undefined') return null
  let best: { row: HTMLElement; area: number } | null = null
  for (const row of document.querySelectorAll<HTMLElement>('.fleet-chat-shape [data-msg-id]')) {
    const rect = row.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) continue
    const area = rect.width * rect.height
    if (!best || area < best.area) best = { row, area }
  }
  if (!best) return null
  const shape = best.row.closest('.fleet-chat-shape')?.closest<HTMLElement>('[data-shape-id]')
  return {
    row: best.row,
    detail: {
      shapeId: shape?.dataset.shapeId ?? '',
      messageId: best.row.dataset.msgId ?? '',
      word: wordAtPoint(best.row, x, y),
    },
  }
}

export function deliverPenCorrection(x: number, y: number, inkShapeId?: string): PenCorrectionTarget | null {
  const target = resolvePenCorrectionTarget(x, y)
  if (!target) return null
  if (inkShapeId) target.detail.inkShapeId = inkShapeId
  const EventConstructor = target.row.ownerDocument.defaultView?.CustomEvent ?? CustomEvent
  target.row.dispatchEvent(new EventConstructor(PEN_CORRECTION_EVENT, {
    bubbles: true,
    detail: target.detail,
  }))
  return target.detail
}

export function completePenCorrection(
  editor: {
    inputs: { getCurrentScreenPoint(): { x: number; y: number } }
    getCurrentPageShapeIds?(): ReadonlySet<TLShapeId>
    getShape?(id: TLShapeId): { type?: string } | undefined
  },
  completeStroke: () => void,
): void {
  const point = editor.inputs.getCurrentScreenPoint()
  const before = editor.getCurrentPageShapeIds?.() ?? new Set<TLShapeId>()
  completeStroke()
  const inkShapeId = [...(editor.getCurrentPageShapeIds?.() ?? [])].find(id =>
    !before.has(id) && editor.getShape?.(id)?.type === 'draw'
  )
  deliverPenCorrection(point.x, point.y, inkShapeId)
}

function wordAtPoint(row: HTMLElement, x: number, y: number): string | null {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let node: Node | null
  while ((node = walker.nextNode())) {
    const text = node.textContent ?? ''
    for (const match of text.matchAll(/\S+/g)) {
      const start = match.index ?? 0
      range.setStart(node, start)
      range.setEnd(node, start + match[0].length)
      for (const rect of range.getClientRects()) {
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return match[0]
      }
    }
  }
  return null
}
