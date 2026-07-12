import { htmlIframeElements } from './shapes/HtmlPageShape'
import type { SourceLocation } from './sourceLocation'
import { normalizeSourceFile, unanchoredSourceLocation } from './sourceLocation'

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

function boundsValue(bounds: any, key: 'x' | 'y' | 'w' | 'h') {
  if (!bounds) return 0
  if (key === 'x') return Number(bounds.x ?? bounds.minX ?? 0)
  if (key === 'y') return Number(bounds.y ?? bounds.minY ?? 0)
  if (key === 'w') return Number(bounds.w ?? bounds.width ?? 0)
  return Number(bounds.h ?? bounds.height ?? 0)
}

export function htmlSourceLineAnchorAtCanvasY(
  shape: { id: string; props?: { h?: number; source?: string } },
  bounds: any,
  canvasY: number,
): HtmlSourceLineAnchor | null {
  const file = normalizeSourceFile(shape?.props?.source || '')
  if (!file) return null

  const shapeId = String(shape.id)
  const iframe = htmlIframeElements.get(shapeId)
  const doc = iframe?.contentDocument
  if (!iframe || !doc) {
    return { ...unanchoredSourceLocation('missing-iframe'), file, page: 0, shapeId }
  }

  const pageY = boundsValue(bounds, 'y')
  const pageH = boundsValue(bounds, 'h') || Number(shape?.props?.h || 0)
  const iframeH = iframe.clientHeight || pageH
  const localY = Math.max(0, Math.min(canvasY - pageY, pageH))
  const iframeY = iframeH && pageH ? localY * (iframeH / pageH) : localY
  const scrollY = iframe.contentWindow?.scrollY || doc.documentElement.scrollTop || doc.body.scrollTop || 0
  const targetY = iframeY + scrollY

  const anchors = Array.from(doc.querySelectorAll<HTMLElement>('[id^="line-"]'))
    .map((el) => {
      const match = el.id.match(/^line-(\d+)$/)
      const line = match ? Number(match[1]) : NaN
      if (!Number.isFinite(line)) return null
      return { line, top: el.offsetTop }
    })
    .filter((entry): entry is { line: number; top: number } => !!entry)
    .sort((a, b) => a.top - b.top)

  if (!anchors.length) {
    return { ...unanchoredSourceLocation('missing-line-anchor'), file, page: 0, shapeId }
  }

  let best = anchors[0]
  for (const anchor of anchors) {
    if (anchor.top > targetY) break
    best = anchor
  }
  return { anchored: true, file, line: best.line, page: 0, shapeId }
}
