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

/**
 * Attempt to extract text under a highlight shape and attach as metadata.
 * Call this after a highlight stroke is completed.
 */
export function snapHighlighterToText(editor: Editor, shapeId: string) {
  try {
    _snapHighlighterToText(editor, shapeId)
  } catch (e: any) {
    console.warn('[highlighter-snap] Error:', e?.message || String(e))
  }
}

function _snapHighlighterToText(editor: Editor, shapeId: string) {
  const shape = editor.getShape(shapeId as any)
  if (!shape) return

  const bounds = editor.getShapePageBounds(shapeId as any)
  if (!bounds) return

  // Find which svg-page shape this highlight overlaps
  const allShapes = editor.getCurrentPageShapes()
  const pageShape = allShapes.find(s => {
    if (s.type !== 'svg-page') return false
    const pageBounds = editor.getShapePageBounds(s.id)
    if (!pageBounds) return false
    return bounds.maxY > pageBounds.minY && bounds.minY < pageBounds.maxY
      && bounds.maxX > pageBounds.minX && bounds.minX < pageBounds.maxX
  })
  if (!pageShape) return

  const pageBounds = editor.getShapePageBounds(pageShape.id)
  if (!pageBounds) return

  const pageEl = document.querySelector(`[data-shape-id="${pageShape.id}"]`)
  if (!pageEl) return

  const svgEl = pageEl.querySelector('svg')
  if (!svgEl) return

  const viewBox = svgEl.viewBox?.baseVal
  if (!viewBox || viewBox.width === 0) return

  const scaleX = viewBox.width / pageBounds.width
  const scaleY = viewBox.height / pageBounds.height

  const hlMinX = (bounds.minX - pageBounds.minX) * scaleX + viewBox.x
  const hlMaxX = (bounds.maxX - pageBounds.minX) * scaleX + viewBox.x
  const hlMinY = (bounds.minY - pageBounds.minY) * scaleY + viewBox.y
  const hlMaxY = (bounds.maxY - pageBounds.minY) * scaleY + viewBox.y
  const hlCenterY = (hlMinY + hlMaxY) / 2
  const hlHeight = hlMaxY - hlMinY

  // Collect text fragments from the SVG, keeping references to DOM elements
  const fragments: TextFragment[] = []
  const textEls = svgEl.querySelectorAll('text')

  for (const textEl of textEls) {
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
      for (const tspan of tspans) {
        const x = parseFloat(tspan.getAttribute('x') || '') || parseFloat(textEl.getAttribute('x') || '') || 0
        const y = parseFloat(tspan.getAttribute('y') || '') || parseFloat(textEl.getAttribute('y') || '') || 0
        const text = tspan.textContent || ''
        if (text) {
          const width = (tspan as SVGTSpanElement).getComputedTextLength?.() || text.length * fontSize * 0.48
          fragments.push({ text, x, y, width, fontSize, el: tspan })
        }
      }
    }
  }

  // For thin strokes (single-line), match by center-y with tight tolerance.
  // For tall strokes (multiline), use the full y-range but shrink by half a line to avoid bleeding.
  const matchedFragments = fragments.filter(f => {
    const lineH = f.fontSize * 1.2  // typical line height
    if (hlHeight < lineH) {
      // Single-line: match baselines near the stroke center
      return Math.abs(f.y - hlCenterY) < f.fontSize * 0.7
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
    console.warn(`[highlighter-snap] 0/${fragments.length} matched. centerY=${hlCenterY.toFixed(1)} hlH=${hlHeight.toFixed(1)} x=[${hlMinX.toFixed(0)},${hlMaxX.toFixed(0)}]. Nearest: ${near.map(f => `y=${f.y.toFixed(1)}(fs=${f.fontSize.toFixed(1)},dist=${Math.abs(f.y-hlCenterY).toFixed(1)},tol=${(f.fontSize*0.7).toFixed(1)}) "${f.text}"`).join(', ')}`)
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

  const midX = bounds.minX + bounds.width / 2
  const midY = bounds.minY + bounds.height / 2
  const sourceLine = getSourceLine(midX, midY, editor)

  const hlColor = (shape.props as any).color || 'yellow'

  // Flash-tint the matched text elements (before updateShape, which can trigger re-renders)
  flashTint(matchedFragments, hlColor)

  // Attach metadata to the highlight shape (deferred so flash isn't wiped by re-render)
  setTimeout(() => {
    editor.updateShape({
      id: shape.id,
      type: shape.type,
      meta: {
        highlightText: matchedText,
        highlightLines: lines,
        sourceLine,
        pageShapeId: pageShape.id,
        glowRects,
        glowColor: hlColor,
      },
    } as any)
  }, 50)

  console.log(`[highlighter-snap] Matched ${lines.length} line(s): "${matchedText.substring(0, 80)}..."`)
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

  const pageEl = document.querySelector(`[data-shape-id="${meta.pageShapeId}"]`)
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
      const tspans = textEl.querySelectorAll('tspan')
      const targets = tspans.length > 0 ? tspans : [textEl]

      for (const target of targets) {
        const ty = parseFloat(target.getAttribute('y') || '') || parseFloat(textEl.getAttribute('y') || '') || 0
        const tx = parseFloat(target.getAttribute('x') || '') || parseFloat(textEl.getAttribute('x') || '') || 0
        if (ty >= yMin && ty <= yMax && tx + 100 > rect.x && tx < rect.x + rect.w) {
          const el = target as SVGElement
          tinted.push({ el, original: el.style.fill || '' })
          el.style.fill = tintColor
          el.setAttribute('data-hl-tint', '1')
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

/** Look up source line from canvas position using the document's page layout. */
function getSourceLine(x: number, y: number, editor: Editor): number | null {
  const pages = editor.getCurrentPageShapes()
    .filter(s => s.type === 'svg-page')
    .sort((a, b) => a.y - b.y)
    .map(s => ({
      bounds: {
        x: s.x,
        y: s.y,
        width: (s.props as any).w,
        height: (s.props as any).h,
      },
      width: (s.props as any).w,
      height: (s.props as any).h,
    }))

  const result = canvasToPdf(x, y, pages)
  return result?.page ?? null
}

export function restoreHighlightsFromShapes(_editor: Editor) {}
