/**
 * Magic Highlighter: extract text under freehand highlight strokes.
 *
 * When user draws a highlighter stroke across text, this module:
 * 1. Finds which SVG page the stroke overlaps
 * 2. Hit-tests against <text>/<tspan> elements in that page's DOM
 * 3. Attaches matched text + source line as metadata on the highlight shape
 * 4. Briefly tints matched text elements, then fades back to original color
 *
 * The stroke itself is unchanged — it stays as a freehand highlight.
 */

import { createShapeId, type Editor } from 'tldraw'
import { canvasToPdf } from './synctexAnchor'
import { openInEditor } from './texsync'
import { dropPillOnTarget } from './shapes/FleetPillShape'
import { dragCoordinator } from './shapes/dragCoordinator'

// Word-space heuristic matching svg-text.mjs: gap > 0.1 * fontSize → space
const SPACE_THRESHOLD = 0.1

// Tint colors for the text glow (solid, not translucent — applied to text fill)
const TINT_COLORS: Record<string, string> = {
  'yellow': '#ca8a04',
  'light-green': '#16a34a',
  'light-blue': '#2563eb',
  'light-violet': '#7c3aed',
  'light-red': '#dc2626',
  'orange': '#ea580c',
  'green': '#16a34a',
  'blue': '#2563eb',
  'violet': '#7c3aed',
  'red': '#dc2626',
  'grey': '#6b7280',
  'black': '#6b7280',
}

/**
 * Pre-compensate a hex color for dark mode's `invert(0.88) hue-rotate(180deg)` filter.
 * The SVG container applies this filter in dark mode, mangling any fill colors we set.
 * This computes the input color that produces the desired output after the filter.
 */
function compensateForDarkMode(hex: string): string {
  // Parse hex
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)

  // Step 1: Undo hue-rotate(180deg) — the matrix is self-inverse
  // CSS hue-rotate(180deg) matrix (cos=-1, sin=0):
  //   [-0.574  1.430  0.144]
  //   [ 0.426  0.430  0.144]
  //   [ 0.426  1.430 -0.856]
  const hr = -0.574 * r + 1.430 * g + 0.144 * b
  const hg = 0.426 * r + 0.430 * g + 0.144 * b
  const hb = 0.426 * r + 1.430 * g - 0.856 * b

  // Step 2: Undo invert(0.88): input = (224.4 - output) / 0.76
  const ir = (224.4 - hr) / 0.76
  const ig = (224.4 - hg) / 0.76
  const ib = (224.4 - hb) / 0.76

  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  return `#${clamp(ir).toString(16).padStart(2, '0')}${clamp(ig).toString(16).padStart(2, '0')}${clamp(ib).toString(16).padStart(2, '0')}`
}

/** Check if the viewer is in dark mode */
function isDarkMode(): boolean {
  return document.documentElement.classList.contains('tl-theme__dark') ||
    window.matchMedia?.('(prefers-color-scheme: dark)').matches
}

interface TextFragment {
  text: string
  x: number
  y: number
  width: number
  fontSize: number
  /** The actual DOM element (text or tspan) for direct tinting */
  el: SVGElement
}

/** Per-line rect in SVG viewBox coordinates, stored in shape meta for hover. */
export interface GlowRect {
  x: number
  y: number
  w: number
  h: number
}

/** A resolved source line, stored in highlight meta. */
export interface SourceLine {
  line: number
  content: string
  file?: string
  highlighted?: boolean
  hlStart?: number  // start column of highlighted substring
  hlEnd?: number    // end column of highlighted substring
}

/**
 * Attempt to extract text under a highlight shape and attach as metadata.
 * Call this after a highlight stroke is completed.
 */
export function snapHighlighterToText(editor: Editor, shapeId: string, docName?: string) {
  try {
    _snapHighlighterToText(editor, shapeId, docName)
  } catch (e: any) {
    console.warn('[highlighter-snap] Error:', e?.message || String(e))
  }
}

function _snapHighlighterToText(editor: Editor, shapeId: string, docName?: string) {
  const shape = editor.getShape(shapeId as any)
  if (!shape) return

  const bounds = editor.getShapePageBounds(shapeId as any)
  if (!bounds) return

  // Find which svg-page shape this highlight overlaps
  const allShapes = editor.getCurrentPageShapes()
  const pageShape = allShapes.find(s => {
    if ((s.type as string) !== 'svg-page') return false
    const pageBounds = editor.getShapePageBounds(s.id)
    if (!pageBounds) return false
    return bounds.maxY > pageBounds.minY && bounds.minY < pageBounds.maxY
      && bounds.maxX > pageBounds.minX && bounds.minX < pageBounds.maxX
  })
  if (!pageShape) return

  const pageBounds = editor.getShapePageBounds(pageShape.id)
  if (!pageBounds) return

  const pageEl = document.querySelector(`[data-shape-id="${pageShape.id}"]:not(.tl-shape-background)`)
  if (!pageEl) return

  const svgEl = pageEl.querySelector('svg')
  if (!svgEl) return

  const viewBox = svgEl.viewBox?.baseVal
  if (!viewBox || viewBox.width === 0) return

  const scaleX = viewBox.width / pageBounds.width
  const scaleY = viewBox.height / pageBounds.height

  // getShapePageBounds includes stroke width, inflating the bbox beyond the path center.
  // Shrink x-range slightly to avoid picking up text just outside the intended highlight.
  // Use a conservative fraction of stroke half-width — enough to cut edge overshoot
  // without collapsing the range for short highlights.
  const hlSize = (shape.props as any).size || 'm'
  const strokeHalfW: Record<string, number> = { s: 4, m: 6, l: 9, xl: 11 }
  const rawMinX = (bounds.minX - pageBounds.minX) * scaleX + viewBox.x
  const rawMaxX = (bounds.maxX - pageBounds.minX) * scaleX + viewBox.x
  const xShrink = (strokeHalfW[hlSize] ?? 6) * scaleX
  // Only shrink if range stays positive (don't collapse short highlights)
  const canShrink = (rawMaxX - rawMinX) > xShrink * 3
  const hlMinX = canShrink ? rawMinX + xShrink : rawMinX
  const hlMaxX = canShrink ? rawMaxX - xShrink : rawMaxX
  const hlMinY = (bounds.minY - pageBounds.minY) * scaleY + viewBox.y
  const hlMaxY = (bounds.maxY - pageBounds.minY) * scaleY + viewBox.y
  const hlCenterY = (hlMinY + hlMaxY) / 2
  const hlHeight = hlMaxY - hlMinY

  // Collect text fragments from the SVG, keeping references to DOM elements
  const fragments: TextFragment[] = []
  const textEls = svgEl.querySelectorAll('text')

  for (const textEl of textEls) {
    // Skip text inside <defs> — these are glyph templates, not rendered text
    if (textEl.closest('defs')) continue

    let fontSize = 10
    const cls = textEl.getAttribute('class') || ''
    const styleMatch = svgEl.querySelector(`style`)?.textContent?.match(
      new RegExp(`text\\.${cls}\\s*\\{[^}]*font-size:\\s*([\\d.]+)px`)
    )
    if (styleMatch) fontSize = parseFloat(styleMatch[1])

    const tspans = textEl.querySelectorAll('tspan')
    if (tspans.length === 0) {
      const x = parseFloat(textEl.getAttribute('x') || '0')
      const y = parseFloat(textEl.getAttribute('y') || '0')
      const text = textEl.textContent || ''
      if (text.trim()) {
        const width = (textEl as SVGTextElement).getComputedTextLength?.() || text.length * fontSize * 0.48
        fragments.push({ text, x, y, width, fontSize, el: textEl })
      }
    } else {
      // Track running y through siblings — SVG tspans inherit y from previous sibling,
      // not from parent <text>. dvisvgm wraps multi-line runs in one <text> element
      // where only the first tspan on each line sets y explicitly.
      let runningY = parseFloat(textEl.getAttribute('y') || '0')
      for (const tspan of tspans) {
        const x = parseFloat(tspan.getAttribute('x') || '') || parseFloat(textEl.getAttribute('x') || '') || 0
        const explicitY = tspan.getAttribute('y')
        if (explicitY) runningY = parseFloat(explicitY)
        const text = tspan.textContent || ''
        if (text) {
          const width = (tspan as SVGTSpanElement).getComputedTextLength?.() || text.length * fontSize * 0.48
          fragments.push({ text, x, y: runningY, width, fontSize, el: tspan })
        }
      }
    }
  }

  // Match text baselines within the highlight's y-range.
  // Single-line: match by center-y with generous tolerance (Apple Pencil strokes tilt).
  // Multi-line: use the full y-range, shrunk by half a line to avoid bleeding.
  const matchedFragments = fragments.filter(f => {
    const lineH = f.fontSize * 1.2
    if (hlHeight < lineH * 1.5) {
      // Single-line: match baselines near the stroke center
      return Math.abs(f.y - hlCenterY) < f.fontSize * 1.0
        && f.x + f.width > hlMinX && f.x < hlMaxX
    } else {
      // Multiline: use full range, shrunk by half a line on each side
      const shrink = f.fontSize * 0.5
      return f.y > hlMinY + shrink && f.y < hlMaxY - shrink
        && f.x + f.width > hlMinX && f.x < hlMaxX
    }
  })


  if (matchedFragments.length === 0) {
    const sorted = [...fragments].sort((a, b) => Math.abs(a.y - hlCenterY) - Math.abs(b.y - hlCenterY))
    const near = sorted.slice(0, 3)
    const nearDesc = near.map(f => `y=${f.y.toFixed(1)} dist=${Math.abs(f.y-hlCenterY).toFixed(1)} "${f.text}"`).join(', ')
    console.warn(`[highlighter-snap] 0/${fragments.length} matched. centerY=${hlCenterY.toFixed(1)} hlH=${hlHeight.toFixed(1)} x=[${hlMinX.toFixed(0)},${hlMaxX.toFixed(0)}]. Nearest: ${nearDesc}`)
    return
  }

  // Group by baseline, merge text with word-space heuristic
  const yBuckets = new Map<number, TextFragment[]>()
  for (const f of matchedFragments) {
    const key = Math.round(f.y * 2) / 2
    if (!yBuckets.has(key)) yBuckets.set(key, [])
    yBuckets.get(key)!.push(f)
  }

  const lines: string[] = []
  const glowRects: GlowRect[] = []
  const sortedKeys = [...yBuckets.keys()].sort((a, b) => a - b)

  for (const yKey of sortedKeys) {
    const bucket = yBuckets.get(yKey)!
    bucket.sort((a, b) => a.x - b.x)

    const lineMinX = bucket[0].x
    const lastFrag = bucket[bucket.length - 1]
    const lineMaxX = lastFrag.x + lastFrag.width
    const fs = bucket[0].fontSize

    glowRects.push({
      x: lineMinX,
      y: yKey - fs * 0.85,
      w: lineMaxX - lineMinX,
      h: fs * 1.15,
    })

    let merged = ''
    for (let i = 0; i < bucket.length; i++) {
      const f = bucket[i]
      if (i > 0) {
        const prev = bucket[i - 1]
        const gap = f.x - (prev.x + prev.width)
        if (gap > f.fontSize * SPACE_THRESHOLD) merged += ' '
      }
      merged += f.text
    }
    lines.push(merged)
  }

  const matchedText = lines.join(' ')
  if (!matchedText.trim()) return

  const hlColor = (shape.props as any).color || 'yellow'

  // Flash-tint removed — the source context card tells the story now

  // Resolve source lines via lookup.json (same data agents see)
  // This is async but we fire-and-forget — meta gets updated when lookup resolves
  // Collect per-fragment positions (in SVG/PDF coords) for column estimation
  const fragmentPositions = matchedFragments.map(f => ({ text: f.text, x: f.x, y: f.y, w: f.width }))

  const resolveAndStore = async () => {
    const sourceLines = docName ? await findSourceLinesFromBounds(docName, bounds, editor, matchedText, shape, fragmentPositions) : []

    // Attach metadata to the highlight shape
    editor.updateShape({
      id: shape.id,
      type: shape.type,
      meta: {
        highlightText: matchedText,
        highlightLines: lines,
        sourceLines,
        pageShapeId: pageShape.id,
        glowRects,
        glowColor: hlColor,
      },
    } as any)

    // Check if calibration succeeded — any highlighted entry with a real range?
    const hlEntries = sourceLines.filter(sl => sl.highlighted)
    const hasGoodMatch = hlEntries.some(sl => sl.hlStart != null && sl.hlEnd != null && sl.hlEnd > sl.hlStart)

    if (sourceLines.length > 0 && hasGoodMatch) {
      showSourceContextCard(sourceLines, hlColor, bounds, editor, false, shape.id)
    } else {
      // Calibration failed — capture screenshot and store on shape meta
      const screenshotDataUrl = captureHighlightRegion(bounds, editor, pageShape.id)
      if (screenshotDataUrl) {
        editor.updateShape({
          id: shape.id,
          type: shape.type,
          meta: {
            ...shape.meta,
            highlightText: matchedText,
            sourceLines,
            screenshotDataUrl,
            unresolved: true,
          },
        } as any)
      }
      showUnresolvedCard(matchedText, hlColor, bounds, editor, pageShape.id, shape.id)
    }

    console.log(`[highlighter-snap] Matched ${lines.length} line(s), ${sourceLines.length} source line(s), calibrated=${hasGoodMatch}: "${matchedText.substring(0, 80)}..."`)
  }
  // Defer slightly so flash isn't wiped by re-render
  setTimeout(resolveAndStore, 50)
}

/** Resolve tint color, compensating for dark mode filter if needed. */
function resolveTintColor(colorName: string): string {
  const base = TINT_COLORS[colorName] || TINT_COLORS.yellow
  return isDarkMode() ? compensateForDarkMode(base) : base
}

/**
 * Show tint on text elements for a highlight shape (call on hover).
 * Returns a cleanup function to remove the tint.
 */
export function showGlow(editor: Editor, shapeId: string): (() => void) | null {
  const shape = editor.getShape(shapeId as any)
  if (!shape) return null

  const meta = shape.meta as any
  if (!meta?.glowRects || !meta?.pageShapeId) return null

  const pageEl = document.querySelector(`[data-shape-id="${meta.pageShapeId}"]:not(.tl-shape-background)`)
  if (!pageEl) return null

  const svgEl = pageEl.querySelector('svg')
  if (!svgEl) return null

  const tintColor = resolveTintColor(meta.glowColor)

  // Find text elements within the glow rect y-ranges
  const textEls = svgEl.querySelectorAll('text')
  const tinted: { el: SVGElement; original: string }[] = []

  for (const rect of meta.glowRects as GlowRect[]) {
    const yMin = rect.y
    const yMax = rect.y + rect.h

    for (const textEl of textEls) {
      if (textEl.closest('defs')) continue
      const tspans = textEl.querySelectorAll('tspan')

      if (tspans.length === 0) {
        const ty = parseFloat(textEl.getAttribute('y') || '0')
        const tx = parseFloat(textEl.getAttribute('x') || '0')
        const tw = (textEl as SVGTextContentElement).getComputedTextLength?.() || 100
        if (ty >= yMin && ty <= yMax && tx + tw > rect.x && tx < rect.x + rect.w) {
          tinted.push({ el: textEl, original: textEl.style.fill || '' })
          textEl.style.fill = tintColor
          textEl.setAttribute('data-hl-tint', '1')
        }
      } else {
        let runY = parseFloat(textEl.getAttribute('y') || '0')
        for (const tspan of tspans) {
          const ey = tspan.getAttribute('y')
          if (ey) runY = parseFloat(ey)
          const tx = parseFloat(tspan.getAttribute('x') || '') || parseFloat(textEl.getAttribute('x') || '') || 0
          const tw = (tspan as SVGTextContentElement).getComputedTextLength?.() || 100
          if (runY >= yMin && runY <= yMax && tx + tw > rect.x && tx < rect.x + rect.w) {
            const el = tspan as SVGElement
            tinted.push({ el, original: el.style.fill || '' })
            el.style.fill = tintColor
            el.setAttribute('data-hl-tint', '1')
          }
        }
      }
    }
  }

  return () => {
    for (const { el, original } of tinted) {
      el.style.fill = original
      if (!original) el.style.removeProperty('fill')
      el.removeAttribute('data-hl-tint')
    }
  }
}

/** Decode base64 highlight path to points (browser-compatible). */
function decodeHighlightPath(b64: string): Array<{ x: number; y: number }> {
  if (!b64 || b64.length === 0) return []
  const raw = atob(b64)
  const buf = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i)
  const dv = new DataView(buf.buffer)
  if (buf.length < 12) return []

  const points: Array<{ x: number; y: number }> = []
  let x = dv.getFloat32(0, true)
  let y = dv.getFloat32(4, true)
  points.push({ x, y })

  // Subsequent: Float16 LE deltas (6 bytes per point: dx, dy, dz)
  for (let off = 12; off + 5 < buf.length; off += 6) {
    x += float16(dv.getUint16(off, true))
    y += float16(dv.getUint16(off + 2, true))
    points.push({ x, y })
  }
  return points
}

function float16(bits: number): number {
  const sign = bits >> 15
  const exp = (bits >> 10) & 0x1f
  const frac = bits & 0x3ff
  if (exp === 0) { const v = frac * (Math.pow(2, -14) / 1024); return sign ? -v : v }
  if (exp === 31) return frac ? NaN : (sign ? -Infinity : Infinity)
  const v = Math.pow(2, exp - 15) * (1 + frac / 1024)
  return sign ? -v : v
}

/**
 * Find source text for a highlight by tracing its path through synctex records.
 * Decodes the highlight path, converts points to PDF coords, sends to server.
 */
async function findSourceLinesFromBounds(
  docName: string,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  editor: Editor,
  highlightText = '',
  shape?: any,
  fragments?: Array<{ text: string; x: number; y: number; w: number }>
): Promise<SourceLine[]> {
  const pages = editor.getCurrentPageShapes()
    .filter(s => (s.type as string) === 'svg-page')
    .sort((a, b) => (a as any).y - (b as any).y)
    .map(s => ({
      bounds: {
        x: (s as any).x,
        y: (s as any).y,
        width: (s.props as any).w,
        height: (s.props as any).h,
      },
      width: (s.props as any).w,
      height: (s.props as any).h,
    }))

  // Decode the highlight path and convert to PDF coords
  const pathPoints: Array<{ x: number; y: number }> = []
  const segments = shape?.props?.segments || []
  for (const seg of segments) {
    if (seg.path) {
      const pts = decodeHighlightPath(seg.path)
      for (const pt of pts) {
        // Points are relative to shape position
        const canvasX = (shape?.x ?? 0) + pt.x
        const canvasY = (shape?.y ?? 0) + pt.y
        const pdf = canvasToPdf(canvasX, canvasY, pages)
        if (pdf) pathPoints.push({ x: pdf.x, y: pdf.y })
      }
    }
  }

  // Fallback: if no path decoded, use center point
  if (pathPoints.length === 0) {
    const centerY = (bounds.minY + bounds.maxY) / 2
    const center = canvasToPdf((bounds.minX + bounds.maxX) / 2, centerY, pages)
    if (!center) return []
    pathPoints.push({ x: center.x, y: center.y })
  }

  // Determine page from first point
  const firstPdf = canvasToPdf(bounds.minX, bounds.minY, pages)
  if (!firstPdf) return []

  // Sample path to ~20 points max for the query
  const sampled = pathPoints.length <= 20 ? pathPoints
    : pathPoints.filter((_, i) => i % Math.ceil(pathPoints.length / 20) === 0)

  const serverUrl = (window as any).__tlda_server || window.location.origin
  try {
    const resp = await fetch(`${serverUrl}/api/projects/${docName}/synctex-path`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        page: firstPdf.page,
        points: sampled,
        text: highlightText || undefined,
        fragments: fragments || undefined,
      }),
    })
    if (!resp.ok) return []
    const data = await resp.json()
    if (!data?.lines) return []

    return data.lines.map((l: any) => {
      const sl: SourceLine = { line: l.line, content: l.content }
      if (l.highlighted) sl.highlighted = true
      if (l.hlStart != null) sl.hlStart = l.hlStart
      if (l.hlEnd != null) sl.hlEnd = l.hlEnd
      if (data.file) sl.file = data.file
      return sl
    })
  } catch (e) {
    console.warn('[highlighter-snap] synctex query failed:', e)
    return []
  }
}

export function restoreHighlightsFromShapes(_editor: Editor) {}

/**
 * Capture a cropped screenshot of the highlight region from the rendered SVG page.
 * Returns a data URL (image/png) or null if capture fails.
 */
function captureHighlightRegion(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  editor: Editor,
  pageShapeId: string,
): string | null {
  try {
    const pageEl = document.querySelector(`[data-shape-id="${pageShapeId}"]`) as HTMLElement | null
    const svgEl = pageEl?.querySelector('svg')
    if (!svgEl) return null
    const pageBounds = editor.getShapePageBounds(pageShapeId as any)
    if (!pageBounds) return null

    const fx = (bounds.minX - pageBounds.x) / pageBounds.w
    const fy = (bounds.minY - pageBounds.y) / pageBounds.h
    const fw = (bounds.maxX - bounds.minX) / pageBounds.w
    const fh = (bounds.maxY - bounds.minY) / pageBounds.h

    const pad = 0.03
    const cx = Math.max(0, fx - pad)
    const cy = Math.max(0, fy - pad * 3)
    const cw = Math.min(1 - cx, fw + pad * 2)
    const ch = Math.min(1 - cy, fh + pad * 6)

    const svgRect = svgEl.getBoundingClientRect()
    const canvas = document.createElement('canvas')
    const scale = 2
    canvas.width = Math.round(svgRect.width * cw * scale)
    canvas.height = Math.round(svgRect.height * ch * scale)

    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.scale(scale, scale)
    ctx.drawImage(
      svgEl as unknown as CanvasImageSource,
      svgRect.width * cx, svgRect.height * cy,
      svgRect.width * cw, svgRect.height * ch,
      0, 0,
      svgRect.width * cw, svgRect.height * ch,
    )
    return canvas.toDataURL('image/png')
  } catch (e) {
    console.warn('[highlighter-snap] screenshot capture failed:', e)
    return null
  }
}

/**
 * Show an "unresolved" card when synctex calibration fails.
 * Displays the SVG-extracted text and a cropped screenshot of the highlighted region.
 */
function showUnresolvedCard(
  highlightText: string,
  hlColor: string,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  editor: Editor,
  pageShapeId: string,
  _shapeId: string,
) {
  const screenPos = editor.pageToScreen({ x: bounds.maxX, y: bounds.minY })
  const tintColor = TINT_COLORS[hlColor] || TINT_COLORS.yellow

  const card = document.createElement('div')
  card.className = 'hl-source-card'

  // Header: "unresolved"
  const header = document.createElement('div')
  header.className = 'hl-source-card-header'
  header.textContent = '⚠ unresolved'
  header.style.color = '#e8a030'
  card.appendChild(header)

  // Body: show the SVG-extracted text
  const body = document.createElement('div')
  body.className = 'hl-source-card-body'
  const hlSpan = document.createElement('span')
  hlSpan.className = 'hl-source-card-match'
  hlSpan.style.backgroundColor = tintColor + '40'
  hlSpan.textContent = highlightText.length > 200 ? highlightText.slice(0, 197) + '...' : highlightText
  body.appendChild(hlSpan)
  card.appendChild(body)

  // Screenshot: crop the region around the highlight from the page SVG
  try {
    const pageEl = document.querySelector(`[data-shape-id="${pageShapeId}"]`) as HTMLElement | null
    const svgEl = pageEl?.querySelector('svg')
    if (svgEl) {
      const pageBounds = editor.getShapePageBounds(pageShapeId as any)
      if (pageBounds) {
        // Convert highlight bounds to SVG viewport fraction
        const fx = (bounds.minX - pageBounds.x) / pageBounds.w
        const fy = (bounds.minY - pageBounds.y) / pageBounds.h
        const fw = (bounds.maxX - bounds.minX) / pageBounds.w
        const fh = (bounds.maxY - bounds.minY) / pageBounds.h

        // Pad the crop region
        const pad = 0.03
        const cx = Math.max(0, fx - pad)
        const cy = Math.max(0, fy - pad * 3)
        const cw = Math.min(1 - cx, fw + pad * 2)
        const ch = Math.min(1 - cy, fh + pad * 6)

        // Create a canvas and draw the cropped SVG region
        const svgRect = svgEl.getBoundingClientRect()
        const canvas = document.createElement('canvas')
        const scale = 2 // retina
        canvas.width = Math.round(svgRect.width * cw * scale)
        canvas.height = Math.round(svgRect.height * ch * scale)
        canvas.style.width = '100%'
        canvas.style.maxWidth = '340px'
        canvas.style.marginTop = '4px'
        canvas.style.borderRadius = '3px'

        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.scale(scale, scale)
          ctx.drawImage(
            svgEl as unknown as CanvasImageSource,
            svgRect.width * cx, svgRect.height * cy,
            svgRect.width * cw, svgRect.height * ch,
            0, 0,
            svgRect.width * cw, svgRect.height * ch,
          )
          card.appendChild(canvas)
        }
      }
    }
  } catch (e) {
    console.warn('[highlighter-snap] screenshot fallback failed:', e)
  }

  // Position
  const left = Math.min(screenPos.x + 12, window.innerWidth - 380)
  const top = Math.max(screenPos.y - 10, 8)
  Object.assign(card.style, {
    position: 'fixed',
    left: `${left}px`,
    top: `${top}px`,
    zIndex: '99999',
  })

  // Auto-dismiss after 8s
  document.body.appendChild(card)
  setTimeout(() => { try { card.remove() } catch {} }, 8000)
}

/** Toggle highlight debug mode (legacy — source context card replaces the debug toast). */
export function toggleHighlightDebug(): boolean {
  const on = !(window as any).__hlDebug
  ;(window as any).__hlDebug = on
  return on
}

/**
 * Show a transient source context card near a highlight.
 * Displays the resolved tex source lines with the matched region highlighted.
 * Also used on hover (browse tool) — call showSourceContextCardForShape for that.
 */
function showSourceContextCard(
  sourceLines: SourceLine[],
  hlColor: string,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  editor: Editor,
  persistent = false,
  shapeId?: string,
): HTMLElement | null {
  if (sourceLines.length === 0) return null

  // Remove any existing card before showing a new one
  document.querySelectorAll('.hl-source-card').forEach(el => el.remove())

  const screenPos = editor.pageToScreen({ x: bounds.maxX, y: bounds.minY })
  const tintColor = TINT_COLORS[hlColor] || TINT_COLORS.yellow

  // Build the card
  const card = document.createElement('div')
  card.className = 'hl-source-card'

  // Header: file + line range
  const highlighted = sourceLines.filter(sl => sl.highlighted === true)
  const first = highlighted.length > 0 ? highlighted[0] : sourceLines[0]
  const last = highlighted.length > 0 ? highlighted[highlighted.length - 1] : sourceLines[sourceLines.length - 1]
  const file = first.file || ''
  const lineRange = first.line === last.line
    ? `L${first.line}`
    : `L${first.line}–${last.line}`
  const headerText = file ? `${file}:${lineRange}` : lineRange

  const header = document.createElement('div')
  header.className = 'hl-source-card-header'
  header.style.display = 'flex'
  header.style.justifyContent = 'space-between'
  header.style.alignItems = 'center'

  const headerLabel = document.createElement('span')
  headerLabel.textContent = headerText
  header.appendChild(headerLabel)

  // "Open in editor" button
  if (file && first.line) {
    const docName = new URLSearchParams(window.location.search).get('doc') || ''
    const editBtn = document.createElement('button')
    editBtn.textContent = '✎'
    editBtn.title = 'Open in editor'
    Object.assign(editBtn.style, {
      background: 'none', border: 'none', cursor: 'pointer',
      fontSize: '14px', opacity: '0.5', padding: '0 2px',
    })
    editBtn.addEventListener('pointerenter', () => { editBtn.style.opacity = '1' })
    editBtn.addEventListener('pointerleave', () => { editBtn.style.opacity = '0.5' })
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      openInEditor(docName, file, first.line)
    })
    header.appendChild(editBtn)
  }

  card.appendChild(header)

  // Render as continuous flowing text, not line-by-line
  // Join all highlighted lines into a passage, find the highlighted substring,
  // show it with context words on each side
  const body = document.createElement('div')
  body.className = 'hl-source-card-body'

  // Build full passage from ALL lines (highlighted + context)
  const passage = sourceLines.map(l => l.content).join(' ')
  const hlLines = highlighted.length > 0 ? highlighted : sourceLines

  // Check if any line has substring highlights (hlStart/hlEnd)
  const hasSubstring = hlLines.some(l => l.hlStart != null && l.hlEnd != null)

  if (hasSubstring) {
    // Collect per-line highlight ranges mapped to passage offsets
    const hlRanges: Array<{ start: number; end: number }> = []
    let offset = 0
    for (const l of sourceLines) {
      if (l.hlStart != null && l.hlEnd != null && l.hlEnd > l.hlStart) {
        hlRanges.push({ start: offset + l.hlStart, end: offset + l.hlEnd })
      }
      offset += l.content.length + 1
    }

    if (hlRanges.length > 0) {
      // Render the full passage — no truncation. The server already scoped
      // context to the surrounding rendered lines; show all of it.
      const showStart = 0
      const showEnd = passage.length

      // Walk through the visible range, alternating between plain and highlighted
      let cursor = showStart
      for (const range of hlRanges) {
        // Plain text before this highlight
        if (cursor < range.start) {
          const s = document.createElement('span')
          s.textContent = passage.slice(cursor, range.start)
          s.style.opacity = '0.5'
          body.appendChild(s)
        }
        // Highlighted text
        const hlSpan = document.createElement('span')
        hlSpan.textContent = passage.slice(range.start, range.end)
        hlSpan.className = 'hl-source-card-match'
        hlSpan.style.backgroundColor = tintColor + '40'
        body.appendChild(hlSpan)
        cursor = range.end
      }

      // Trailing context after last highlight
      if (cursor < showEnd) {
        const s = document.createElement('span')
        s.textContent = passage.slice(cursor, showEnd)
        s.style.opacity = '0.5'
        body.appendChild(s)
      }

      if (showEnd < passage.length) {
        const ellipsis = document.createElement('span')
        ellipsis.textContent = '...'
        ellipsis.style.opacity = '0.3'
        body.appendChild(ellipsis)
      }
    } else {
      // Fallback: show the whole passage
      body.textContent = passage.length > 200 ? passage.slice(0, 197) + '...' : passage
    }
  } else {
    // No substring match — show the highlighted passage as-is
    body.textContent = passage.length > 200 ? passage.slice(0, 197) + '...' : passage
  }

  card.appendChild(body)

  // Position
  const left = Math.min(screenPos.x + 12, window.innerWidth - 380)
  const top = Math.max(screenPos.y - 10, 8)
  Object.assign(card.style, {
    position: 'fixed',
    left: `${left}px`,
    top: `${top}px`,
    zIndex: '99999',
  })

  // Click card to insert chip into active chat input
  if (shapeId) {
    card.style.cursor = 'grab'
    card.setAttribute('data-shape-id', shapeId)
    const highlighted = sourceLines.filter(sl => sl.highlighted === true)
    const first = highlighted.length > 0 ? highlighted[0] : sourceLines[0]
    const displayText = (first?.content?.slice(0, 40) || 'highlight').replace(/[«»]/g, '')
    const token = `«highlight:${displayText}#${shapeId}»`

    let dragState: { pillId: string | null; startX: number; startY: number; started: boolean } | null = null

    card.addEventListener('pointerdown', (e) => {
      e.stopPropagation()
      e.preventDefault()
      // Use HUD editor for pill creation (chat shapes live in HUD coordinate system)
      const hudEditor = (window as any).__tldraw_hud_editor__ as Editor | undefined
      const pillEditor = hudEditor || editor
      dragState = { pillId: null, startX: e.clientX, startY: e.clientY, started: false }

      dragCoordinator.claim(
        // onMove
        (ev: PointerEvent) => {
          if (!dragState) return
          const dx = ev.clientX - dragState.startX
          const dy = ev.clientY - dragState.startY
          if (!dragState.started) {
            if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return
            dragState.started = true
            const pagePos = pillEditor.screenToPage({ x: ev.clientX, y: ev.clientY })
            const pillId = createShapeId()
            pillEditor.run(() => {
              pillEditor.createShape({
                id: pillId,
                type: 'fleet-pill' as any,
                x: pagePos.x,
                y: pagePos.y,
                props: { w: 80, h: 18, pillType: 'highlight', value: shapeId, displayName: displayText, color: '#e8a030' },
              })
            }, { history: 'ignore' })
            dragState.pillId = pillId as unknown as string
            pillEditor.cancel()
            // Animate card shrinking into pill, then remove
            Object.assign(card.style, {
              transition: 'transform 0.2s ease-in, opacity 0.2s ease-in',
              transform: 'scale(0.3)',
              opacity: '0',
            })
            setTimeout(() => card.remove(), 200)
            return
          }
          if (dragState.pillId) {
            const pagePos = pillEditor.screenToPage({ x: ev.clientX, y: ev.clientY })
            pillEditor.run(() => {
              pillEditor.updateShape({ id: dragState!.pillId as any, type: 'fleet-pill' as any, x: pagePos.x - 40, y: pagePos.y - 9 })
            }, { history: 'ignore' })
          }
        },
        // onUp
        (ev: PointerEvent) => {
          if (dragState?.pillId) {
            const pillId = dragState.pillId
            const dropPoint = pillEditor.screenToPage({ x: ev.clientX, y: ev.clientY })
            dropPillOnTarget(pillEditor, pillId as any, token, dropPoint, token)
            try { pillEditor.run(() => { pillEditor.deleteShapes([pillId as any]) }, { history: 'ignore' }) } catch {}
          }
          dragState = null
          dragCoordinator.release()
        },
      )
    })
  }

  // Click to dismiss
  card.addEventListener('click', (e) => {
    e.stopPropagation()
    card.remove()
  })

  document.body.appendChild(card)

  if (!persistent) {
    // Auto-fade after 4 seconds, but cancel if hovered (so user can drag it)
    const fadeTimer = setTimeout(() => { card.style.opacity = '0' }, 4000)
    const removeTimer = setTimeout(() => { card.remove() }, 5000)
    card.addEventListener('pointerenter', () => {
      clearTimeout(fadeTimer)
      clearTimeout(removeTimer)
      card.style.opacity = '1'
    })
    // Dismiss when pointer leaves the card (after hover kept it alive)
    card.addEventListener('pointerleave', () => {
      setTimeout(() => { card.style.opacity = '0' }, 1000)
      setTimeout(() => { try { card.remove() } catch {} }, 1500)
    })
  }

  return card
}

/**
 * Show source context card for an existing highlight shape (e.g. on hover).
 * Returns a cleanup function to remove the card.
 */
export function showSourceContextCardForShape(editor: Editor, shapeId: string): (() => void) | null {
  const shape = editor.getShape(shapeId as any)
  if (!shape || (shape.type as string) !== 'highlight') return null

  const meta = shape.meta as any
  let sourceLines: SourceLine[] = meta?.sourceLines
  // Fallback: if no sourceLines, create one from highlightText
  if (!sourceLines || sourceLines.length === 0) {
    const hlText = meta?.highlightText || meta?.highlightedText
    if (!hlText) return null
    sourceLines = [{ line: 0, content: hlText, highlighted: true }]
  }

  const bounds = editor.getShapePageBounds(shapeId as any)
  if (!bounds) return null

  const hlColor = meta?.glowColor || (shape.props as any).color || 'yellow'
  const card = showSourceContextCard(sourceLines, hlColor, bounds, editor, true, shapeId)
  if (!card) return null

  return () => { card.remove() }
}
