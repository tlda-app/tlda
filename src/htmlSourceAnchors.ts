import { htmlIframeElements } from './htmlIframeRegistry'
import type { SourceLocation } from './sourceLocation'
import { normalizeSourceFile, type SourceLocationReason } from './sourceLocation'

export type HtmlSourceLineAnchor =
  | (Extract<SourceLocation, { anchored: true }> & {
      page: 0
      shapeId: string
    })
  | (Extract<SourceLocation, { anchored: false }> & {
      file: string
      page: 0
      shapeId: string
    })

function unanchoredHtmlAnchor(
  reason: SourceLocationReason,
  file: string,
  shapeId: string,
): Exclude<HtmlSourceLineAnchor, { anchored: true }> {
  return { anchored: false, reason, file, page: 0, shapeId }
}

function boundsValue(bounds: any, key: 'x' | 'y' | 'w' | 'h') {
  if (!bounds) return 0
  if (key === 'x') return Number(bounds.x ?? bounds.minX ?? 0)
  if (key === 'y') return Number(bounds.y ?? bounds.minY ?? 0)
  if (key === 'w') return Number(bounds.w ?? bounds.width ?? 0)
  return Number(bounds.h ?? bounds.height ?? 0)
}

function htmlAnchorContext(
  shape: { id: string; props?: { h?: number; source?: string } },
  bounds: any,
) {
  const file = normalizeSourceFile(shape?.props?.source || '')
  if (!file) return null

  const shapeId = String(shape.id)
  const iframe = htmlIframeElements.get(shapeId)
  const doc = iframe?.contentDocument
  if (!iframe || !doc) {
    return {
      ok: false as const,
      anchor: unanchoredHtmlAnchor('missing-iframe', file, shapeId),
    }
  }

  const pageY = boundsValue(bounds, 'y')
  const pageH = boundsValue(bounds, 'h') || Number(shape?.props?.h || 0)
  const iframeH = iframe.clientHeight || pageH
  const scrollY = iframe.contentWindow?.scrollY || doc.documentElement?.scrollTop || doc.body?.scrollTop || 0
  return { ok: true as const, file, shapeId, iframe, doc, pageY, pageH, iframeH, scrollY }
}

export function htmlSourceLineAnchorAtCanvasY(
  shape: { id: string; props?: { h?: number; source?: string } },
  bounds: any,
  canvasY: number,
): HtmlSourceLineAnchor | null {
  const context = htmlAnchorContext(shape, bounds)
  if (!context) return null
  if (!context.ok) return context.anchor

  const localY = Math.max(0, Math.min(canvasY - context.pageY, context.pageH))
  const iframeY = context.iframeH && context.pageH ? localY * (context.iframeH / context.pageH) : localY
  const targetY = iframeY + context.scrollY

  const anchors = Array.from(context.doc.querySelectorAll<HTMLElement>('[id^="line-"]'))
    .map((el) => {
      const match = el.id.match(/^line-(\d+)$/)
      const line = match ? Number(match[1]) : NaN
      if (!Number.isFinite(line)) return null
      return { line, top: el.offsetTop }
    })
    .filter((entry): entry is { line: number; top: number } => !!entry)
    .sort((a, b) => a.top - b.top)

  if (!anchors.length) {
    return unanchoredHtmlAnchor('missing-line-anchor', context.file, context.shapeId)
  }

  let best = anchors[0]
  for (const anchor of anchors) {
    if (anchor.top > targetY) break
    best = anchor
  }
  return { anchored: true, file: context.file, line: best.line, page: 0, shapeId: context.shapeId }
}

export function htmlSourceLineCanvasPosition(
  shape: { id: string; props?: { h?: number; source?: string } },
  bounds: any,
  line: number,
): (Extract<HtmlSourceLineAnchor, { anchored: true }> & { canvasY: number }) | Exclude<HtmlSourceLineAnchor, { anchored: true }> | null {
  const context = htmlAnchorContext(shape, bounds)
  if (!context) return null
  if (!context.ok) return context.anchor

  const sourceLine = Math.max(1, Math.floor(Number(line)))
  if (!Number.isFinite(sourceLine)) {
    return unanchoredHtmlAnchor('unresolved', context.file, context.shapeId)
  }

  const el = context.doc.getElementById(`line-${sourceLine}`) as HTMLElement | null
  if (!el) {
    return unanchoredHtmlAnchor('missing-line-anchor', context.file, context.shapeId)
  }

  const localY = (el.offsetTop - context.scrollY) * (context.pageH / (context.iframeH || context.pageH || 1))
  return {
    anchored: true,
    file: context.file,
    line: sourceLine,
    page: 0,
    shapeId: context.shapeId,
    canvasY: context.pageY + localY,
  }
}
