import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  useEditor,
  useValue,
} from 'tldraw'
import { useEffect, useRef, useState } from 'react'
import { injectSvgFonts } from './svgFonts'

// Client-side SVG text store — keyed by shape ID, not synced through Yjs
// Populated by svgDocumentLoader, read by the shape component
export const svgTextStore = new Map<string, string>()

// SVG viewBox dimensions per shape, for coordinate conversion
export interface SvgViewBox { minX: number; minY: number; width: number; height: number }
export const svgViewBoxStore = new Map<string, SvgViewBox>()
export function getSvgViewBox(shapeId: string): SvgViewBox | undefined {
  return svgViewBoxStore.get(shapeId)
}

// Anchor index: anchorId → { pageShapeId, viewBox }
// Built during SVG loading so cross-page links can be resolved
export interface AnchorEntry {
  pageShapeId: string
  // view element's viewBox attribute gives us the scroll target
  viewBox?: string
}
export const anchorIndex = new Map<string, AnchorEntry>()

// Callback for cross-page navigation — set by SvgDocument
// anchorId is the <view> element ID (e.g. "loc84"), title is xlink:title (e.g. "equation.28")
let navigateToAnchor: ((anchorId: string, title: string) => void) | null = null
export function setNavigateToAnchor(fn: ((anchorId: string, title: string) => void) | null) {
  navigateToAnchor = fn
}

// --- Change highlight store (local "unread" state, not synced via Yjs) ---

export interface ChangeRegion {
  y: number       // viewBox y coordinate (top of changed region)
  height: number  // region height in viewBox units
}

export const changeStore = new Map<string, ChangeRegion[]>()  // shapeId → regions
export const changedPages = new Set<string>()                 // shapeIds with unread changes

type ChangeListener = () => void
const changeListeners = new Set<ChangeListener>()

export function onChangeStoreUpdate(fn: ChangeListener): () => void {
  changeListeners.add(fn)
  return () => { changeListeners.delete(fn) }
}

function notifyChangeListeners() {
  for (const fn of changeListeners) fn()
}

export function setChangeHighlights(shapeId: string, regions: ChangeRegion[]) {
  if (regions.length > 0) {
    changeStore.set(shapeId, regions)
    changedPages.add(shapeId)
  } else {
    changeStore.delete(shapeId)
    changedPages.delete(shapeId)
  }
  notifyChangeListeners()
}

export function dismissPageChanges(shapeId: string) {
  changeStore.delete(shapeId)
  changedPages.delete(shapeId)
  notifyChangeListeners()
}

export function dismissAllChanges() {
  changeStore.clear()
  changedPages.clear()
  notifyChangeListeners()
}

/** Clear all module-level stores — call on document switch to prevent stale data. */
export function clearDocumentStores() {
  svgTextStore.clear()
  svgViewBoxStore.clear()
  anchorIndex.clear()
  changeStore.clear()
  changedPages.clear()
  notifyChangeListeners()
}

// Expose change store on window for testing/debugging
if (typeof window !== 'undefined') {
  (window as any).__changeStore__ = { changeStore, changedPages, setChangeHighlights, dismissAllChanges, dismissPageChanges, svgViewBoxStore }
}

export class SvgPageShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'svg-page' as const
  static override props = {
    w: T.number,
    h: T.number,
    pageIndex: T.number,
    version: T.number,
  }

  getDefaultProps() {
    return { w: 800, h: 1035, pageIndex: 0, version: 0 }
  }

  override canEdit = () => false
  override canResize = () => false
  override isAspectRatioLocked = () => true
  override hideRotateHandle = () => true
  override canBind = () => false

  component(shape: any) {
    return <SvgPageComponent shape={shape} />
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} />
  }
}

function SvgPageComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const isDark = useValue('isDarkMode', () => editor.user.getIsDarkMode(), [editor])
  const containerRef = useRef<HTMLDivElement>(null)
  const svgText = svgTextStore.get(shape.id)

  // Subscribe to change store for this shape's highlights
  const [highlights, setHighlights] = useState<ChangeRegion[]>(() => changeStore.get(shape.id) || [])
  useEffect(() => {
    return onChangeStoreUpdate(() => {
      setHighlights(changeStore.get(shape.id) || [])
    })
  }, [shape.id])

  const viewBox = svgViewBoxStore.get(shape.id)

  // Inject SVG and wire up link clicks
  // Re-runs when version changes (hot reload) or svgText changes
  useEffect(() => {
    const el = containerRef.current
    if (!el || !svgText) return

    el.innerHTML = svgText

    // Scale the SVG to fill the shape bounds
    const svgEl = el.querySelector('svg')
    if (svgEl) {
      svgEl.setAttribute('width', '100%')
      svgEl.setAttribute('height', '100%')
      svgEl.style.display = 'block'
    }

    // Inject space characters between positioned SVG text fragments so native
    // browser text selection produces readable text (with word breaks).
    // Must wait for fonts to load before measuring text widths.
    if (svgEl) {
      injectSvgFonts(svgEl)
      document.fonts.ready.then(() => injectWordSpaces(svgEl))
    }

    // Process <a> elements: strip native href (prevents browser navigation),
    // store the anchor target and title in data attributes, style as clickable
    const links = el.querySelectorAll('a')
    for (const link of links) {
      const href = link.getAttribute('xlink:href') || link.getAttribute('href') || ''
      const title = link.getAttribute('xlink:title') || ''
      const match = href.match(/#(.+)$/)
      if (match) {
        link.setAttribute('data-anchor', match[1])
      }
      if (title) {
        link.setAttribute('data-title', title)
      }
      // Remove native href so browser doesn't try to navigate
      link.removeAttribute('xlink:href')
      link.removeAttribute('href')
      link.style.cursor = 'pointer'
    }

    // Single delegated click handler on the container
    const onClick = (e: MouseEvent) => {
      const target = (e.target as Element).closest('a')
      if (!target) return
      const anchorId = target.getAttribute('data-anchor')
      const title = target.getAttribute('data-title') || anchorId || ''
      if (anchorId && navigateToAnchor) {
        e.preventDefault()
        e.stopPropagation()
        navigateToAnchor(anchorId, title)
      }
    }
    el.addEventListener('click', onClick)

    return () => {
      el.removeEventListener('click', onClick)
    }
  }, [svgText, shape.id, shape.props.version])

  return (
    <HTMLContainer>
      <div style={{ position: 'relative', width: shape.props.w, height: shape.props.h }}>
        <div
          ref={containerRef}
          style={{
            width: shape.props.w,
            height: shape.props.h,
            background: isDark ? '#1a1a2e' : 'white',
            filter: isDark ? 'invert(1) hue-rotate(180deg)' : 'none',
            overflow: 'hidden',
            pointerEvents: 'all',
          }}
        />
        {highlights.length > 0 && viewBox && highlights.map((r, i) => (
          <div
            key={i}
            className="change-highlight"
            style={{
              top: `${((r.y - viewBox.minY) / viewBox.height) * 100}%`,
              height: `${(r.height / viewBox.height) * 100}%`,
            }}
          />
        ))}
      </div>
    </HTMLContainer>
  )
}

/**
 * Inject space characters between positioned SVG text fragments.
 *
 * dvisvgm outputs text as <text> elements with positioned <tspan> children,
 * but no actual space characters between words. This makes native browser
 * text selection produce run-together text like "BalancingWeights".
 *
 * We walk each <text> element, use getComputedTextLength() to measure fragment
 * widths (returns SVG user units), and insert a space text node wherever there's
 * a word-sized gap. Font sizes are parsed from the SVG stylesheet (also in SVG
 * units) rather than getComputedStyle (which returns scaled CSS pixels).
 */
function injectWordSpaces(svgEl: SVGSVGElement) {
  // Parse font info per CSS class from the SVG's own <style> (in SVG user units).
  // Multiple page SVGs in the same document have conflicting class names (e.g.
  // text.f21 means different fonts on different pages), so we parse THIS page's
  // styles and apply them inline to ensure correct measurement.
  const fontInfoMap: Record<string, { family: string; size: number }> = {}
  const styleEl = svgEl.querySelector('style')
  if (styleEl) {
    const cssText = styleEl.textContent || ''
    const re = /text\.(\w+)\s*\{font-family:(\w+);font-size:([\d.]+)px\}/g
    let m
    while ((m = re.exec(cssText)) !== null) {
      fontInfoMap[m[1]] = { family: m[2], size: parseFloat(m[3]) }
    }
  }

  const textEls = svgEl.querySelectorAll('text')

  // Apply inline font styles to each text element so getComputedTextLength
  // uses the correct font (not a conflicting class from another page's CSS)
  for (const textEl of textEls) {
    const textClass = textEl.getAttribute('class') || ''
    const fi = fontInfoMap[textClass]
    if (fi) {
      textEl.style.fontFamily = fi.family
      textEl.style.fontSize = fi.size + 'px'
    }
  }

  for (const textEl of textEls) {
    const textClass = textEl.getAttribute('class') || ''
    const fontSize = fontInfoMap[textClass]?.size || 10

    // Collect fragments: direct text nodes and tspan children, in DOM order
    type Frag = { node: Node; x: number; y: number; width: number }
    const frags: Frag[] = []
    let baseX = parseFloat(textEl.getAttribute('x') || '0')
    let baseY = parseFloat(textEl.getAttribute('y') || '0')
    let currentY = baseY

    for (const child of textEl.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent || ''
        if (!text.trim()) continue
        // Wrap bare text in a temporary tspan to measure it
        const tmp = document.createElementNS('http://www.w3.org/2000/svg', 'tspan')
        tmp.textContent = text
        textEl.insertBefore(tmp, child.nextSibling)
        const width = tmp.getComputedTextLength()
        textEl.removeChild(tmp)
        frags.push({ node: child, x: baseX, y: currentY, width })
      } else if (child.nodeType === Node.ELEMENT_NODE && (child as Element).tagName === 'tspan') {
        const tspan = child as SVGTSpanElement
        const text = tspan.textContent || ''
        if (!text.trim()) continue
        const xAttr = tspan.getAttribute('x')
        const yAttr = tspan.getAttribute('y')
        if (yAttr) currentY = parseFloat(yAttr)
        const x = xAttr ? parseFloat(xAttr) : baseX
        const width = tspan.getComputedTextLength()
        frags.push({ node: child, x, y: currentY, width })
      }
    }

    if (frags.length < 2) continue

    // Insert space text nodes (iterate backwards to preserve DOM indices).
    // dvisvgm gap distribution is cleanly bimodal: kerns < 0.05em, word spaces > 0.23em.
    // Threshold of 0.15em cleanly separates them with wide margin on both sides.
    const threshold = fontSize * 0.15
    for (let i = frags.length - 1; i >= 1; i--) {
      if (frags[i].y !== frags[i - 1].y) {
        // Different baseline = line break within same <text> element
        textEl.insertBefore(document.createTextNode(' '), frags[i].node)
        continue
      }
      const gap = frags[i].x - (frags[i - 1].x + frags[i - 1].width)
      if (gap > threshold) {
        textEl.insertBefore(document.createTextNode(' '), frags[i].node)
      }
    }
  }
}
