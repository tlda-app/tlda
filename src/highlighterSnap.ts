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

import type { Editor } from 'tldraw'
import { canvasToPdf } from './synctexAnchor'

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

  // Flash-tint the matched text elements (before updateShape, which can trigger re-renders)
  flashTint(matchedFragments, hlColor)

  // Resolve source lines via lookup.json (same data agents see)
  // This is async but we fire-and-forget — meta gets updated when lookup resolves
  const resolveAndStore = async () => {
    const sourceLines = docName ? await findSourceLinesFromBounds(docName, bounds, editor, matchedText) : []

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

    // Show source context card
    showSourceContextCard(sourceLines, hlColor, bounds, editor)

    console.log(`[highlighter-snap] Matched ${lines.length} line(s), ${sourceLines.length} source line(s): "${matchedText.substring(0, 80)}..."`)
  }
  // Defer slightly so flash isn't wiped by re-render
  setTimeout(resolveAndStore, 50)
}

/** Resolve tint color, compensating for dark mode filter if needed. */
function resolveTintColor(colorName: string): string {
  const base = TINT_COLORS[colorName] || TINT_COLORS.yellow
  return isDarkMode() ? compensateForDarkMode(base) : base
}

/** Temporarily tint matched text elements, then fade back to original. */
function flashTint(fragments: TextFragment[], colorName: string) {
  const tintColor = resolveTintColor(colorName)

  for (const f of fragments) {
    const el = f.el as SVGElement
    const original = el.style.fill || ''
    el.style.fill = tintColor
    el.setAttribute('data-hl-tint', '1')
    // Hold for 1s, then fade over 2s
    setTimeout(() => {
      el.style.transition = 'fill 2s ease-out'
      el.style.fill = original || ''
      setTimeout(() => {
        el.style.removeProperty('transition')
        if (!original) el.style.removeProperty('fill')
        el.removeAttribute('data-hl-tint')
      }, 2200)
    }, 1000)
  }
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

/**
 * Find source lines for a highlight by querying the server's synctex data.
 * Returns the actual tex source with context and the highlighted region identified.
 */
async function findSourceLinesFromBounds(
  docName: string,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  editor: Editor,
  highlightText = ''
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

  // Convert highlight center + x-range to PDF coords
  const centerY = (bounds.minY + bounds.maxY) / 2
  const center = canvasToPdf((bounds.minX + bounds.maxX) / 2, centerY, pages)
  const left = canvasToPdf(bounds.minX, centerY, pages)
  const right = canvasToPdf(bounds.maxX, centerY, pages)
  if (!center) return []

  // Query the server's synctex reverse lookup with center point
  const serverUrl = (window as any).__tlda_server || window.location.origin
  const params = new URLSearchParams({
    page: String(center.page),
    startX: String(left?.x ?? center.x),
    startY: String(center.y),
    endX: String(right?.x ?? center.x),
    endY: String(center.y),
    context: '1',
    ...(highlightText ? { text: highlightText } : {}),
  })

  try {
    const resp = await fetch(`${serverUrl}/api/projects/${docName}/synctex?${params}`)
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
  persistent = false
): HTMLElement | null {
  if (sourceLines.length === 0) return null

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
  header.textContent = headerText
  card.appendChild(header)

  // Render as continuous flowing text, not line-by-line
  // Join all highlighted lines into a passage, find the highlighted substring,
  // show it with context words on each side
  const body = document.createElement('div')
  body.className = 'hl-source-card-body'

  // Build full passage from highlighted lines
  const hlLines = highlighted.length > 0 ? highlighted : sourceLines
  const passage = hlLines.map(l => l.content).join(' ')

  // Check if any line has substring highlights (hlStart/hlEnd)
  const hasSubstring = hlLines.some(l => l.hlStart != null && l.hlEnd != null)

  if (hasSubstring) {
    // Find the highlighted substring within the joined passage
    // Reconstruct from per-line hlStart/hlEnd
    let offset = 0
    let passageHlStart = -1
    let passageHlEnd = -1
    for (const l of hlLines) {
      if (l.hlStart != null && l.hlEnd != null) {
        if (passageHlStart === -1) passageHlStart = offset + l.hlStart
        passageHlEnd = offset + l.hlEnd
      }
      offset += l.content.length + 1 // +1 for the join space
    }

    if (passageHlStart >= 0 && passageHlEnd > passageHlStart) {
      // Show: ...context before... [highlighted text] ...context after...
      const contextChars = 40
      const before = passage.slice(Math.max(0, passageHlStart - contextChars), passageHlStart)
      const match = passage.slice(passageHlStart, passageHlEnd)
      const after = passage.slice(passageHlEnd, passageHlEnd + contextChars)

      if (passageHlStart > contextChars) {
        const ellipsis = document.createElement('span')
        ellipsis.textContent = '...'
        ellipsis.style.opacity = '0.3'
        body.appendChild(ellipsis)
      }

      if (before) {
        const s = document.createElement('span')
        s.textContent = before
        s.style.opacity = '0.5'
        body.appendChild(s)
      }

      const hlSpan = document.createElement('span')
      hlSpan.textContent = match
      hlSpan.className = 'hl-source-card-match'
      hlSpan.style.backgroundColor = tintColor + '40'
      body.appendChild(hlSpan)

      if (after) {
        const s = document.createElement('span')
        s.textContent = after
        s.style.opacity = '0.5'
        body.appendChild(s)
      }

      if (passageHlEnd + contextChars < passage.length) {
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

  // Click to dismiss
  card.addEventListener('click', (e) => {
    e.stopPropagation()
    card.remove()
  })

  document.body.appendChild(card)

  if (!persistent) {
    // Auto-fade after 4 seconds
    setTimeout(() => { card.style.opacity = '0' }, 4000)
    setTimeout(() => { card.remove() }, 5000)
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
  const sourceLines: SourceLine[] = meta?.sourceLines
  if (!sourceLines || sourceLines.length === 0) return null

  const bounds = editor.getShapePageBounds(shapeId as any)
  if (!bounds) return null

  const hlColor = meta?.glowColor || (shape.props as any).color || 'yellow'
  const card = showSourceContextCard(sourceLines, hlColor, bounds, editor, true)
  if (!card) return null

  return () => { card.remove() }
}
