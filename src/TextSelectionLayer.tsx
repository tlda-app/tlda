// Text extraction utilities for SVG pages
// Used by SvgDocument, svgDocumentLoader, snapshotStore for text diffing and search

export interface TextLine {
  text: string
  x: number      // SVG viewBox coordinate (start of line)
  y: number      // SVG viewBox coordinate (baseline)
  fontSize: number
  fontFamily: string
}

export interface PageTextData {
  lines: TextLine[]
  viewBox: { minX: number; minY: number; width: number; height: number }
}

import { injectSvgFonts, waitForFonts, parseFontClasses, type FontInfo } from './svgFonts'

/**
 * Measure text width using canvas with the actual CM font.
 */
function createMeasurer() {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  let currentFont = ''

  return {
    measure(text: string, fontFamily: string, fontSize: number): number {
      const font = `${fontSize}px ${fontFamily}`
      if (font !== currentFont) {
        ctx.font = font
        currentFont = font
      }
      return ctx.measureText(text).width
    }
  }
}

interface RawFragment {
  text: string
  x: number
  y: number
  fontClass: string
}

/**
 * Find the space/kern threshold for a line's gaps via largest-jump clustering.
 * Gaps naturally bimodal: kerns near 0, word spaces ~2-4px. We find the
 * biggest jump in the sorted gap values and split there.
 */
function findSpaceThreshold(gaps: number[], fontSize: number): number {
  if (gaps.length === 0) return fontSize * 0.2

  const sorted = [...gaps].sort((a, b) => a - b)
  let maxJump = 0
  let jumpIdx = 0
  for (let i = 0; i < sorted.length - 1; i++) {
    const jump = sorted[i + 1] - sorted[i]
    if (jump > maxJump) {
      maxJump = jump
      jumpIdx = i
    }
  }

  let threshold = (sorted[jumpIdx] + sorted[jumpIdx + 1]) / 2

  // Clamp: at least 0.5px (anything smaller is definitely a kern),
  // at most 0.4em (anything larger is definitely a word space).
  threshold = Math.max(threshold, 0.5)
  threshold = Math.min(threshold, fontSize * 0.4)

  return threshold
}

/**
 * Extract text from SVG, merge fragments into lines with proper word spacing.
 * Must be called after injectSvgFonts() and waitForFonts().
 */
export function extractTextFromSvg(
  svgDoc: Document,
  fontClasses: Record<string, FontInfo>
): PageTextData | null {
  const svgEl = svgDoc.querySelector('svg')
  if (!svgEl) return null

  const viewBoxAttr = svgEl.getAttribute('viewBox')
  if (!viewBoxAttr) return null
  const vbParts = viewBoxAttr.split(/\s+/).map(Number)
  if (vbParts.length !== 4) return null
  const viewBox = { minX: vbParts[0], minY: vbParts[1], width: vbParts[2], height: vbParts[3] }

  // Collect raw fragments
  const fragments: RawFragment[] = []
  const textEls = svgDoc.querySelectorAll('text')

  for (const textEl of textEls) {
    const cls = textEl.getAttribute('class') || ''
    const baseX = parseFloat(textEl.getAttribute('x') || '0')
    const baseY = parseFloat(textEl.getAttribute('y') || '0')

    // Track current y position — in SVG, a tspan with y= establishes a new
    // baseline that subsequent tspans (without y=) inherit.
    let currentY = baseY

    for (const node of textEl.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || ''
        if (text.trim()) {
          fragments.push({ text, x: baseX, y: currentY, fontClass: cls })
        }
      } else if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'tspan') {
        const tspan = node as Element
        const text = tspan.textContent || ''
        if (!text.trim()) continue
        const tx = parseFloat(tspan.getAttribute('x') || '') || baseX
        const yAttr = tspan.getAttribute('y')
        if (yAttr) currentY = parseFloat(yAttr)
        fragments.push({ text, x: tx, y: currentY, fontClass: cls })
      }
    }
  }

  // Group by baseline y (quantize to 0.5 units)
  const lineMap = new Map<number, RawFragment[]>()
  for (const f of fragments) {
    const yKey = Math.round(f.y * 2) / 2
    let group = lineMap.get(yKey)
    if (!group) {
      group = []
      lineMap.set(yKey, group)
    }
    group.push(f)
  }

  // Merge fragments into lines using measured widths for gap detection.
  // canvas.measureText doesn't perfectly match dvisvgm positioning, so we
  // use an adaptive threshold: find the natural break in each line's gap
  // distribution (kerns cluster near 0, word spaces cluster higher).
  const measurer = createMeasurer()
  const lines: TextLine[] = []

  for (const [, group] of lineMap) {
    group.sort((a, b) => a.x - b.x)

    const fi = fontClasses[group[0].fontClass] || { family: 'serif', size: 10 }

    // First pass: compute all inter-fragment gaps
    const gaps: number[] = []
    const endXs: number[] = [group[0].x + measurer.measure(group[0].text, fi.family, fi.size)]
    for (let i = 1; i < group.length; i++) {
      const frag = group[i]
      const fragFont = fontClasses[frag.fontClass] || fi
      gaps.push(frag.x - endXs[i - 1])
      endXs.push(frag.x + measurer.measure(frag.text, fragFont.family, fragFont.size))
    }

    // Find adaptive threshold via largest jump in sorted gaps
    const threshold = findSpaceThreshold(gaps, fi.size)

    // Second pass: merge with detected spaces
    let text = group[0].text
    for (let i = 1; i < group.length; i++) {
      if (gaps[i - 1] > threshold) {
        text += ' '
      }
      text += group[i].text
    }

    lines.push({
      text,
      x: group[0].x,
      y: group[0].y,
      fontSize: fi.size,
      fontFamily: fi.family,
    })
  }

  lines.sort((a, b) => a.y - b.y || a.x - b.x)
  return { lines, viewBox }
}

/**
 * Top-level extraction: inject fonts, wait for load, then extract.
 */
export async function extractTextFromSvgAsync(svgDoc: Document): Promise<PageTextData | null> {
  injectSvgFonts(svgDoc)
  await waitForFonts()
  const fontClasses = parseFontClasses(svgDoc)
  return extractTextFromSvg(svgDoc, fontClasses)
}

