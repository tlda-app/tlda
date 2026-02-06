import React, { useEffect, useState, useRef, useMemo, memo } from 'react'
import { useEditor, useValue } from 'tldraw'
import { getYRecords } from './useYjsSync'

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

// Shared font injection state
let fontsInjected = false
const injectedFontFamilies = new Set<string>()

/**
 * Inject @font-face rules from an SVG into the page so we can use
 * canvas.measureText() with the exact CM fonts.
 */
function injectSvgFonts(svgDoc: Document) {
  if (fontsInjected) return
  const styleEl = svgDoc.querySelector('style')
  if (!styleEl) return

  const cssText = styleEl.textContent || ''
  // Extract @font-face blocks
  const fontFaceRe = /@font-face\{[^}]+\}/g
  const matches = cssText.match(fontFaceRe)
  if (!matches) return

  const pageStyle = document.createElement('style')
  pageStyle.textContent = matches.join('\n')
  document.head.appendChild(pageStyle)

  // Track which families we injected
  const familyRe = /font-family:(\w+)/
  for (const m of matches) {
    const fm = m.match(familyRe)
    if (fm) injectedFontFamilies.add(fm[1])
  }

  fontsInjected = true
}

/**
 * Wait for injected CM fonts to be ready.
 */
async function waitForFonts() {
  if (injectedFontFamilies.size === 0) return
  await document.fonts.ready
}

interface FontInfo {
  family: string
  size: number
}

/**
 * Parse font class → { family, size } mapping from SVG style.
 */
function parseFontClasses(svgDoc: Document): Record<string, FontInfo> {
  const result: Record<string, FontInfo> = {}
  const styleEl = svgDoc.querySelector('style')
  if (!styleEl) return result

  const cssText = styleEl.textContent || ''
  const re = /text\.(\w+)\s*\{font-family:(\w+);font-size:([\d.]+)px\}/g
  let m
  while ((m = re.exec(cssText)) !== null) {
    result[m[1]] = { family: m[2], size: parseFloat(m[3]) }
  }
  return result
}

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

// ─── React components ───

interface TextSelectionLayerProps {
  pages: Array<{
    bounds: { x: number; y: number; width: number; height: number }
    textData?: PageTextData | null
  }>
}

/**
 * Text selection overlay. Activate via:
 * - Hold Alt (desktop)
 * - Select the text-select tool from toolbar (iPad/pen)
 */
interface SelectionAnchor {
  line: number
  char: number
}

// Selection state lifted to layer level so it persists across tool switches
interface GlobalSelection {
  pageIndex: number
  start: SelectionAnchor
  end: SelectionAnchor
}

export function TextSelectionLayer({ pages }: TextSelectionLayerProps) {
  const editor = useEditor()
  const containerRef = useRef<HTMLDivElement>(null)
  const [camera, setCamera] = useState(() => editor.getCamera())
  const [altHeld, setAltHeld] = useState(false)
  const altRef = useRef(false)

  // Activate when the text-select tool is current
  const isTextSelectTool = useValue('text-select tool',
    () => editor.getCurrentToolId() === 'text-select', [editor])

  const active = altHeld || isTextSelectTool

  // Selection persists even when tool is not active
  const [globalSel, setGlobalSel] = useState<GlobalSelection | null>(null)

  // Clear selection when clicking outside while not in text-select mode
  const clearSel = useRef(() => { setGlobalSel(null) })
  clearSel.current = () => { setGlobalSel(null) }

  useEffect(() => {
    const unsub = editor.store.listen(
      () => setCamera(editor.getCamera()),
      { scope: 'session', source: 'all' }
    )
    return unsub
  }, [editor])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt') { altRef.current = true; setAltHeld(true) }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') { altRef.current = false; setAltHeld(false) }
    }
    const onPointerDown = () => {
      if (!altRef.current && !isTextSelectTool) {
        window.getSelection()?.removeAllRanges()
        clearSel.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [isTextSelectTool])


  const vpBounds = editor.getViewportPageBounds()
  const visiblePages = pages
    .map((p, i) => ({ ...p, pageIndex: i }))
    .filter(p => {
      const pb = p.bounds
      const margin = vpBounds.height
      return pb.y + pb.height >= vpBounds.y - margin &&
             pb.y <= vpBounds.y + vpBounds.height + margin &&
             p.textData
    })

  return (
    <div
      ref={containerRef}
      className={active ? 'text-selection-layer active' : 'text-selection-layer'}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        transformOrigin: 'top left',
        transform: `scale(${camera.z}) translate(${camera.x}px, ${camera.y}px)`,
        pointerEvents: 'none',
        touchAction: active ? 'auto' : undefined,
        zIndex: 100,
      }}
    >
      {visiblePages.map((page) => (
        <PageTextOverlay
          key={page.pageIndex}
          page={page}
          pageIndex={page.pageIndex}
          active={active}
          globalSel={globalSel}
          setGlobalSel={setGlobalSel}
        />
      ))}
    </div>
  )
}

/**
 * Find the character index in `text` closest to `offsetSvg` pixels
 * from the start of the line (in SVG coordinate units).
 */
function charIndexAtX(
  text: string,
  offsetSvg: number,
  fontFamily: string,
  fontSize: number,
  measurer: ReturnType<typeof createMeasurer>
): number {
  if (offsetSvg <= 0) return 0
  for (let i = 1; i <= text.length; i++) {
    const w = measurer.measure(text.slice(0, i), fontFamily, fontSize)
    if (w >= offsetSvg) {
      const wPrev = i > 1 ? measurer.measure(text.slice(0, i - 1), fontFamily, fontSize) : 0
      return (offsetSvg - wPrev < w - offsetSvg) ? i - 1 : i
    }
  }
  return text.length
}

const PageTextOverlay = memo(function PageTextOverlay({ page, pageIndex, active, globalSel, setGlobalSel }: {
  page: { bounds: { x: number; y: number; width: number; height: number }; textData?: PageTextData | null }
  pageIndex: number
  active: boolean
  globalSel: GlobalSelection | null
  setGlobalSel: (sel: GlobalSelection | null) => void
}) {
  const td = page.textData!
  const vb = td.viewBox
  const scaleX = page.bounds.width / vb.width
  const scaleY = page.bounds.height / vb.height

  const measurer = useMemo(() => createMeasurer(), [])

  const linePositions = useMemo(() => td.lines.map((line) => {
    const fontSize = line.fontSize * scaleY
    const top = (line.y - vb.minY) * scaleY - fontSize * 0.8
    const left = (line.x - vb.minX) * scaleX
    const width = measurer.measure(line.text, line.fontFamily, line.fontSize) * scaleX
    return { top, height: fontSize, left, width }
  }), [td, scaleX, scaleY, measurer])

  const dragging = useRef(false)
  const anchor = useRef<SelectionAnchor>({ line: 0, char: 0 })

  // This page's selection (from the global state)
  const sel = globalSel?.pageIndex === pageIndex ? { start: globalSel.start, end: globalSel.end } : null

  const getLineAndChar = (e: React.PointerEvent): SelectionAnchor => {
    const rect = e.currentTarget.getBoundingClientRect()
    const localY = e.clientY - rect.top
    const localX = e.clientX - rect.left

    let lineIdx = linePositions.length - 1
    for (let i = 0; i < linePositions.length; i++) {
      if (localY < linePositions[i].top + linePositions[i].height) {
        lineIdx = i
        break
      }
    }

    const line = td.lines[lineIdx]
    const svgX = localX / scaleX + vb.minX
    const offsetInLine = svgX - line.x
    const charIdx = charIndexAtX(line.text, offsetInLine, line.fontFamily, line.fontSize, measurer)

    return { line: lineIdx, char: charIdx }
  }

  const normalizeSelection = (a: SelectionAnchor, b: SelectionAnchor) => {
    if (a.line < b.line || (a.line === b.line && a.char <= b.char)) {
      return { start: a, end: b }
    }
    return { start: b, end: a }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (!active) return
    e.stopPropagation()
    e.preventDefault()
    dragging.current = true
    const pos = getLineAndChar(e)
    anchor.current = pos
    setGlobalSel({ pageIndex, start: pos, end: pos })
    ;(e.target as Element).setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!active || !dragging.current) return
    e.stopPropagation()
    const pos = getLineAndChar(e)
    const norm = normalizeSelection(anchor.current, pos)
    setGlobalSel({ pageIndex, ...norm })
  }

  const onPointerUp = (e: React.PointerEvent) => {
    if (!active) return
    e.stopPropagation()
    dragging.current = false
    if (!sel) return

    // Extract selected text with character precision
    const lines: string[] = []
    for (let i = sel.start.line; i <= sel.end.line; i++) {
      const text = td.lines[i].text
      if (i === sel.start.line && i === sel.end.line) {
        lines.push(text.slice(sel.start.char, sel.end.char))
      } else if (i === sel.start.line) {
        lines.push(text.slice(sel.start.char))
      } else if (i === sel.end.line) {
        lines.push(text.slice(0, sel.end.char))
      } else {
        lines.push(text)
      }
    }
    const text = lines.join('\n')
    if (!text.trim()) return

    // Write to Yjs
    const yRecords = getYRecords()
    if (yRecords) {
      yRecords.set('signal:text-selection' as any, {
        text,
        pageIndex,
        page: pageIndex + 1,
        lineStart: sel.start.line,
        lineEnd: sel.end.line,
        timestamp: Date.now(),
      } as any)
    }
  }

  // Render highlight rectangles — visible even when tool is not active
  const highlights: React.ReactNode[] = []
  if (sel) {
    for (let i = sel.start.line; i <= sel.end.line; i++) {
      const lp = linePositions[i]
      const line = td.lines[i]
      let hlLeft: number, hlWidth: number

      if (sel.start.line === sel.end.line) {
        const startW = measurer.measure(line.text.slice(0, sel.start.char), line.fontFamily, line.fontSize) * scaleX
        const endW = measurer.measure(line.text.slice(0, sel.end.char), line.fontFamily, line.fontSize) * scaleX
        hlLeft = lp.left + startW
        hlWidth = endW - startW
      } else if (i === sel.start.line) {
        const startW = measurer.measure(line.text.slice(0, sel.start.char), line.fontFamily, line.fontSize) * scaleX
        hlLeft = lp.left + startW
        hlWidth = lp.width - startW
      } else if (i === sel.end.line) {
        const endW = measurer.measure(line.text.slice(0, sel.end.char), line.fontFamily, line.fontSize) * scaleX
        hlLeft = lp.left
        hlWidth = endW
      } else {
        hlLeft = lp.left
        hlWidth = lp.width
      }

      if (hlWidth > 0) {
        highlights.push(
          <div key={i} style={{
            position: 'absolute',
            top: lp.top,
            left: hlLeft,
            width: hlWidth,
            height: lp.height,
            backgroundColor: 'rgba(59, 130, 246, 0.25)',
            borderRadius: 2,
            pointerEvents: 'none',
          }} />
        )
      }
    }
  }

  return (
    <div
      data-page-index={pageIndex}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        position: 'absolute',
        left: page.bounds.x,
        top: page.bounds.y,
        width: page.bounds.width,
        height: page.bounds.height,
        pointerEvents: active ? 'auto' : 'none',
        cursor: active ? 'text' : undefined,
        overflow: 'hidden',
        touchAction: active ? 'none' : undefined,
      }}
    >
      {highlights}
    </div>
  )
})
