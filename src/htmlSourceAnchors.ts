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

/**
 * Where a rendered block says which source line it came from.
 *
 * `id="line-N"` is what tlda's own markdown renderer emits. Quarto renders its
 * own HTML and emits nothing, so `server/lib/quarto-source-lines.mjs` marks its
 * blocks with `data-source-line` at build time — the attribute `htmlSelection`
 * already reads. Both spellings are the same fact, so both are read here.
 */
const SOURCE_LINE_SELECTOR = '[id^="line-"], [data-source-line]'

function sourceLineOfElement(el: HTMLElement): number | null {
  const raw = el.id.match(/^line-(\d+)$/)?.[1] ?? el.getAttribute('data-source-line')
  const line = raw == null ? NaN : Number(raw)
  return Number.isFinite(line) && line > 0 ? Math.floor(line) : null
}

/**
 * Whether the element occupies space on the page right now.
 *
 * A Quarto callout can render collapsed, and a collapsed block reports
 * `offsetTop` 0 — measured on a real chapter, one marked paragraph from line 819
 * sat at 0 while the block above it was at 19819. Sorted by position that block
 * becomes the FIRST anchor in the document, so an annotation dropped at the top
 * of the chapter anchors to a line near the end. Markdown never hit this because
 * its renderer emits no collapsible blocks.
 */
function isRendered(el: HTMLElement): boolean {
  return el.getClientRects().length > 0
}

function boundsValue(bounds: any, key: 'x' | 'y' | 'w' | 'h') {
  if (!bounds) return 0
  if (key === 'x') return Number(bounds.x ?? bounds.minX ?? 0)
  if (key === 'y') return Number(bounds.y ?? bounds.minY ?? 0)
  if (key === 'w') return Number(bounds.w ?? bounds.width ?? 0)
  return Number(bounds.h ?? bounds.height ?? 0)
}

/**
 * Whether the document in the frame is the one this shape is anchored to.
 *
 * A frame can be showing something else: these documents carry links to other
 * chapters and to external pages, nothing intercepts an ordinary in-frame
 * navigation, and `props.url` is not updated when one happens — so the shape
 * still names its own file while the frame displays another.
 *
 * That matters because "an iframe and a document exist" was the whole check.
 * A remap against a navigated-away frame reads a REAL document, misses the
 * marker in it, and persists `missing-line-anchor` over a good anchor — the
 * same destruction the transient guards fix, reached by another road.
 *
 * **Unknown is not mismatch.** When the URL cannot be read or the file cannot
 * be turned into a path, this answers `true`. A guard that cannot tell must not
 * block: answering `false` on uncertainty would unanchor everything while
 * looking like caution.
 */
function documentMatchesSource(url: string, sourceFile: string): boolean {
  const path = String(url || '').split('#', 1)[0].split('?', 1)[0]
  // The source is authored (.qmd, .md); the frame holds the rendered .html.
  const target = String(sourceFile || '')
    .replace(/^\.?\//, '')
    .replace(/\.(qmd|md|markdown)$/i, '.html')
  if (!path || !target) return true
  const basename = target.replace(/^.*\//, '')
  return path.endsWith('/' + target) || path.endsWith('/' + basename)
}

/** The document the frame actually holds; `src` when its location is unreadable. */
function loadedDocumentUrl(iframe: HTMLIFrameElement): string {
  try {
    return iframe.contentWindow?.location?.href || iframe.src || ''
  } catch {
    return iframe.src || ''
  }
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

  // Reading the wrong document is not an answer about this one.
  if (!documentMatchesSource(loadedDocumentUrl(iframe), file)) {
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

  const anchors = Array.from(context.doc.querySelectorAll<HTMLElement>(SOURCE_LINE_SELECTOR))
    .map((el) => {
      const line = sourceLineOfElement(el)
      if (line == null || !isRendered(el)) return null
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
  // `null` means "cannot answer right now", and the caller must treat it that
  // way: `remapAnnotations` skips a null without writing, where an unanchored
  // value is PERSISTED into the note's meta and never reconsidered — it filters
  // to `sourceAnchor.anchored !== false`. So returning an unanchored value for a
  // transient condition does not report a failure, it destroys the anchor.
  //
  // Measured: a remap running while the iframe was mid-refresh turned a good
  // `{anchored: true, line: 29}` into `{anchored: false, reason:
  // 'missing-iframe'}`, permanently, on one reload.
  if (!context.ok) return null

  const sourceLine = Math.max(1, Math.floor(Number(line)))
  if (!Number.isFinite(sourceLine)) {
    return unanchoredHtmlAnchor('unresolved', context.file, context.shapeId)
  }

  const el = (context.doc.getElementById(`line-${sourceLine}`)
    || context.doc.querySelector(`[data-source-line="${sourceLine}"]`)) as HTMLElement | null

  // The line is genuinely gone from the render — the source moved on. That is a
  // real answer about the source and it is kept.
  if (!el) {
    return unanchoredHtmlAnchor('missing-line-anchor', context.file, context.shapeId)
  }

  // The block exists but has no layout box: collapsed inside a callout, or the
  // document has not finished laying out. Both are states the anchor outlives,
  // so hold the position rather than answer — the anchor stays valid and
  // resolves once the block is laid out again.
  if (!isRendered(el)) return null

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
