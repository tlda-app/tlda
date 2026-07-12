import { htmlIframeElements } from './shapes/HtmlPageShape'

export type HtmlSourceLineAnchor =
  | {
      anchored: true
      source: 'html-page'
      file: string
      line: number
      page: 0
      shapeId: string
    }
  | {
      anchored: false
      source: 'html-page'
      file: string
      line: null
      page: 0
      shapeId: string
      reason: 'missing-iframe' | 'missing-line-anchor'
    }

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
  const file = String(shape?.props?.source || '').replace(/^\.\//, '')
  if (!file) return null

  const shapeId = String(shape.id)
  const iframe = htmlIframeElements.get(shapeId)
  const doc = iframe?.contentDocument
  if (!iframe || !doc) {
    return { anchored: false, source: 'html-page', file, line: null, page: 0, shapeId, reason: 'missing-iframe' }
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
    return { anchored: false, source: 'html-page', file, line: null, page: 0, shapeId, reason: 'missing-line-anchor' }
  }

  let best = anchors[0]
  for (const anchor of anchors) {
    if (anchor.top > targetY) break
    best = anchor
  }
  return { anchored: true, source: 'html-page', file, line: best.line, page: 0, shapeId }
}
