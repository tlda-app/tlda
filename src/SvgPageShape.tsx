import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  useEditor,
  useValue,
} from 'tldraw'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { injectSvgFonts } from './svgFonts'
import { injectWordSpaces } from './svgWordSpaces'
import { subscribeSvgText, getSvgText } from './stores/svgTextStore'
import { changeStore, onShapeChangeUpdate, type ChangeRegion } from './stores/changeStore'
import { getNavigateToAnchor, getOnSourceClick } from './stores/anchorIndex'

export class SvgPageShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'svg-page' as const
  static override props = {
    w: T.number,
    h: T.number,
    pageIndex: T.number,
  }

  getDefaultProps() {
    return { w: 800, h: 1035, pageIndex: 0 }
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

// Number of page-heights beyond the viewport to keep SVG content injected
const VIEWPORT_BUFFER_PAGES = 2

function SvgPageComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const isDark = useValue('isDarkMode', () => editor.user.getIsDarkMode(), [editor])
  const containerRef = useRef<HTMLDivElement>(null)

  // Subscribe to reactive SVG text store
  const svgText = useSyncExternalStore(
    (cb) => subscribeSvgText(shape.id, cb),
    () => getSvgText(shape.id),
  )

  // Track what's currently injected so we skip redundant DOM work
  const injectedRef = useRef<string | null>(null)
  // Cached text element Y-positions for fast tinting (rebuilt on SVG injection)
  const textYCacheRef = useRef<{ el: SVGTextElement; y: number }[]>([])


  // Track whether this page is near the viewport (±2 pages buffer)
  const isNearViewport = useValue('near-viewport-' + shape.id, () => {
    const viewport = editor.getViewportPageBounds()
    const margin = shape.props.h * VIEWPORT_BUFFER_PAGES
    // Simple vertical check — pages are stacked vertically
    const shapeTop = shape.y
    const shapeBottom = shape.y + shape.props.h
    return shapeBottom > viewport.minY - margin && shapeTop < viewport.maxY + margin
  }, [editor, shape.id, shape.y, shape.props.h])

  // Subscribe to change store for THIS shape's highlights only (not all shapes)
  const [highlights, setHighlights] = useState<ChangeRegion[]>(() => changeStore.get(shape.id) || [])
  useEffect(() => {
    return onShapeChangeUpdate(shape.id, () => {
      setHighlights(changeStore.get(shape.id) || [])
    })
  }, [shape.id])

  // Inject or clear SVG based on viewport proximity
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    if (!isNearViewport || !svgText) {
      // Off-screen: clear DOM to free memory
      if (injectedRef.current !== null) {
        el.innerHTML = ''
        injectedRef.current = null
        textYCacheRef.current = []
      }
      return
    }

    // Already injected this exact content — skip
    if (injectedRef.current === svgText) return

    el.innerHTML = svgText
    injectedRef.current = svgText

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

      // Build Y-position cache for fast tinting (avoids querySelectorAll + parseFloat on every highlight change)
      const textEls = svgEl.querySelectorAll('text')
      const cache: { el: SVGTextElement; y: number }[] = new Array(textEls.length)
      for (let i = 0; i < textEls.length; i++) {
        cache[i] = { el: textEls[i], y: parseFloat(textEls[i].getAttribute('y') || '0') }
      }
      textYCacheRef.current = cache
    } else {
      textYCacheRef.current = []
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

    // Apply any pending tint highlights
    applyTinting(textYCacheRef.current, highlights)
  }, [isNearViewport, svgText])

  // Click handler — stable, doesn't depend on SVG content
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const onClick = (e: MouseEvent) => {
      // Cmd-click: open source in editor
      const onSourceClick = getOnSourceClick()
      if (e.metaKey && onSourceClick) {
        e.preventDefault()
        e.stopPropagation()
        const rect = el.getBoundingClientRect()
        const clickY = (e.clientY - rect.top) / rect.height
        onSourceClick(shape.id, clickY)
        return
      }

      const target = (e.target as Element).closest('a')
      if (!target) return
      const anchorId = target.getAttribute('data-anchor')
      const title = target.getAttribute('data-title') || anchorId || ''
      const navigateToAnchor = getNavigateToAnchor()
      if (anchorId && navigateToAnchor) {
        e.preventDefault()
        e.stopPropagation()
        navigateToAnchor(anchorId, title)
      }
    }
    el.addEventListener('click', onClick)
    return () => { el.removeEventListener('click', onClick) }
  }, [shape.id])

  // Apply text tinting when highlights change (and SVG is injected)
  useEffect(() => {
    if (injectedRef.current === null) return
    applyTinting(textYCacheRef.current, highlights)
  }, [highlights])

  return (
    <HTMLContainer>
      <div style={{ position: 'relative', width: shape.props.w, height: shape.props.h }}>
        <div
          style={{
            width: shape.props.w,
            height: shape.props.h,
            background: isDark ? '#0f0f1a' : 'white',
            overflow: 'hidden',
            pointerEvents: 'all',
          }}
        >
          <div
            ref={containerRef}
            style={{
              width: '100%',
              height: '100%',
              filter: isDark ? 'invert(0.88) hue-rotate(180deg)' : 'none',
            }}
          />
        </div>
      </div>
    </HTMLContainer>
  )
}

/** Apply text tinting to SVG text elements within change regions.
 *  Uses pre-built Y-position cache to avoid querySelectorAll + parseFloat on every call. */
function applyTinting(cache: { el: SVGTextElement; y: number }[], highlights: ChangeRegion[]) {
  // Reset all
  for (let i = 0; i < cache.length; i++) {
    const t = cache[i].el
    t.removeAttribute('data-tinted')
    t.style.removeProperty('fill')
  }

  const tinted = highlights.filter(r => r.tint)
  if (tinted.length === 0) return

  for (let i = 0; i < cache.length; i++) {
    const ty = cache[i].y
    for (const r of tinted) {
      if (ty >= r.y && ty <= r.y + r.height) {
        cache[i].el.style.fill = r.tint!
        cache[i].el.setAttribute('data-tinted', '1')
        break
      }
    }
  }
}
