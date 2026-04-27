import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  useEditor,
  useValue,
} from 'tldraw'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { injectSvgFonts } from '../svgFonts'
import { injectWordSpaces } from '../svgWordSpaces'
import { subscribeSvgText, getSvgText, setSvgText } from '../stores/svgTextStore'
import { changeStore, onShapeChangeUpdate, type ChangeRegion } from '../stores/changeStore'
import { getNavigateToAnchor, getOnSourceClick } from '../stores/anchorIndex'

export class SvgPageShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'svg-page' as const
  static override props = {
    w: T.number,
    h: T.number,
    pageIndex: T.number,
    version: T.optional(T.number),
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

  backgroundComponent(shape: any) {
    return <SvgPageBackground shape={shape} />
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} />
  }
}

// Number of page-heights beyond the viewport to keep SVG content injected
const IS_PHONE = typeof window !== 'undefined' && window.matchMedia('(max-width: 600px)').matches
const VIEWPORT_BUFFER_PAGES = IS_PHONE ? 4 : 2

// Cache processed SVG HTML (post-fonts + word spaces + link processing) keyed by shape ID.
// Avoids re-running the expensive injectWordSpaces on scroll-back re-injection.
const processedSvgCache = new Map<string, { svgText: string; html: string }>()

// Queue injectWordSpaces work one page per idle frame to avoid main-thread freeze on load.
type WordSpaceJob = () => void
const wordSpaceQueue: WordSpaceJob[] = []
let wordSpaceScheduled = false

function enqueueWordSpaces(job: WordSpaceJob) {
  wordSpaceQueue.push(job)
  if (!wordSpaceScheduled) {
    wordSpaceScheduled = true
    scheduleNextWordSpace()
  }
}

function scheduleNextWordSpace() {
  if (typeof requestIdleCallback !== 'undefined') {
    requestIdleCallback(drainWordSpaceQueue, { timeout: 1500 })
  } else {
    setTimeout(drainWordSpaceQueue, 0)
  }
}

function drainWordSpaceQueue() {
  const job = wordSpaceQueue.shift()
  if (job) {
    job()
    if (wordSpaceQueue.length > 0) {
      scheduleNextWordSpace()
    } else {
      wordSpaceScheduled = false
    }
  } else {
    wordSpaceScheduled = false
  }
}

function SvgPageComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const isDark = useValue('isDarkMode', () => editor.user.getIsDarkMode(), [editor])
  const containerRef = useRef<HTMLDivElement>(null)

  // Subscribe to reactive SVG text store
  const svgText = useSyncExternalStore(
    (cb) => subscribeSvgText(shape.id, cb),
    () => getSvgText(shape.id),
  )

  // Auto-fetch SVG for compare pages: compare shapes sync via Yjs but
  // the SVG text lives in a local JS Map that doesn't sync. Each browser
  // must independently fetch the SVGs. Detect compare pages by shape ID
  // and fetch from the shadow cache URL.
  useEffect(() => {
    if (svgText) return  // already have it
    const idStr = shape.id as string
    if (!idStr.includes('compare-page-')) return  // not a compare page
    // Extract hash from Yjs signal (stored when compare was triggered)
    // For now, try fetching from all available shadow caches
    // The shape's pageIndex tells us which page to fetch (0-based → page-N.svg is 1-based)
    const pageIdx = shape.props.pageIndex
    // Read the compare ref from the signal cache
    const fetchCompare = async () => {
      try {
        // Get doc name from URL query param
        const docName = new URLSearchParams(window.location.search).get('doc') || 'bregman'
        const sigRes = await fetch(`/api/projects/${docName}/signal/signal:compare`)
        if (!sigRes.ok) return
        const sig = await sigRes.json()
        const ref = sig?.data?.ref
        if (!ref) return
        const hash7 = ref.slice(0, 7)
        const url = `/docs/${docName}/history/shadow-${hash7}/page-${pageIdx + 1}.svg`
        const res = await fetch(url)
        if (!res.ok) return
        const text = await res.text()
        setSvgText(shape.id as string, text)
      } catch {}
    }
    fetchCompare()
  }, [shape.id, shape.props.pageIndex, svgText])

  // Track what's currently injected so we skip redundant DOM work
  const injectedRef = useRef<string | null>(null)
  // Cached text element Y-positions for fast tinting (rebuilt on SVG injection)
  const textYCacheRef = useRef<{ el: SVGTextElement; y: number }[]>([])


  // Track whether this page is near the viewport (±2 pages buffer).
  // Check both axes — compare columns live at a different X position
  // and would never render with a vertical-only check.
  const isNearViewport = useValue('near-viewport-' + shape.id, () => {
    const viewport = editor.getViewportPageBounds()
    const b = editor.getShapePageBounds(shape.id)
    if (!b) return false
    const marginY = b.h * VIEWPORT_BUFFER_PAGES
    const marginX = b.w * 2
    return b.x + b.w > viewport.minX - marginX && b.x < viewport.maxX + marginX &&
           b.y + b.h > viewport.minY - marginY && b.y < viewport.maxY + marginY
  }, [editor, shape.id])

  // Fetch SVG when page enters the viewport — handles both initial load and re-entry.
  // On first entry (no svgText): fetch the SVG.
  // On re-entry (svgText exists): re-fetch to pick up any builds that happened while off-screen.
  // Skip compare pages — they have their own fetch logic above.
  const prevIsNearViewportRef = useRef(false)
  useEffect(() => {
    const wasNear = prevIsNearViewportRef.current
    prevIsNearViewportRef.current = isNearViewport

    // Only act on false→true transitions
    if (!isNearViewport || wasNear) return

    const idStr = shape.id as string
    if (idStr.includes('compare-page-')) return

    const docName = new URLSearchParams(window.location.search).get('doc')
    if (!docName) return

    const url = `/docs/${docName}/page-${shape.props.pageIndex + 1}.svg`
    fetch(url).then(async res => {
      if (!res.ok) return
      const newText = await res.text()
      if (newText !== svgText) setSvgText(shape.id as string, newText)
    }).catch(() => {})
  }, [isNearViewport, svgText, shape.id, shape.props.pageIndex])

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

    // Check for cached processed HTML (avoids re-running expensive injectWordSpaces on scroll-back)
    const cacheEntry = processedSvgCache.get(shape.id)
    if (cacheEntry && cacheEntry.svgText === svgText) {
      el.innerHTML = cacheEntry.html
      injectedRef.current = svgText
      const svgEl = el.querySelector('svg')
      if (svgEl) {
        const textEls = svgEl.querySelectorAll('text')
        const tCache: { el: SVGTextElement; y: number }[] = new Array(textEls.length)
        for (let i = 0; i < textEls.length; i++) {
          tCache[i] = { el: textEls[i], y: parseFloat(textEls[i].getAttribute('y') || '0') }
        }
        textYCacheRef.current = tCache
      } else {
        textYCacheRef.current = []
      }
      applyTinting(textYCacheRef.current, highlights)
      return
    }

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
    // Must wait for fonts to load; queue one page per idle frame to avoid
    // blocking the main thread when multiple pages load simultaneously.
    if (svgEl) {
      injectSvgFonts(svgEl)
      const capturedSvgText = svgText
      document.fonts.ready.then(() => {
        enqueueWordSpaces(() => {
          if (!containerRef.current || injectedRef.current !== capturedSvgText) return
          injectWordSpaces(svgEl)
          // Cache the fully-processed HTML so scroll-back re-injection is instant
          processedSvgCache.set(shape.id, { svgText: capturedSvgText, html: el.innerHTML })
        })
      })

      // Build Y-position cache for fast tinting (avoids querySelectorAll + parseFloat on every highlight change)
      const textEls = svgEl.querySelectorAll('text')
      const tCache: { el: SVGTextElement; y: number }[] = new Array(textEls.length)
      for (let i = 0; i < textEls.length; i++) {
        tCache[i] = { el: textEls[i], y: parseFloat(textEls[i].getAttribute('y') || '0') }
      }
      textYCacheRef.current = tCache
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

      // Expand hit area: inject a transparent rect with padding so that clicks
      // near the link text (e.g. on surrounding brackets or whitespace) still fire.
      // SVG <text> elements have no padding — without this, the clickable area is
      // exactly the glyph bounding box, making precise clicking necessary.
      const svgElForLink = link.closest('svg')
      if (svgElForLink && link.childElementCount > 0) {
        try {
          const bbox = (link as unknown as SVGAElement).getBBox()
          if (bbox.width > 0 && bbox.height > 0) {
            const pad = 4
            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
            rect.setAttribute('x', String(bbox.x - pad))
            rect.setAttribute('y', String(bbox.y - pad))
            rect.setAttribute('width', String(bbox.width + pad * 2))
            rect.setAttribute('height', String(bbox.height + pad * 2))
            rect.setAttribute('fill', 'transparent')
            rect.setAttribute('pointer-events', 'all')
            link.insertBefore(rect, link.firstChild)
          }
        } catch { /* getBBox may fail for off-screen elements */ }
      }
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

function SvgPageBackground({ shape: _shape }: { shape: any }) {
  return <div className="svg-page-background" />
}

/** Apply text tinting to SVG text elements within change regions.
 *  Uses pre-built Y-position cache to avoid querySelectorAll + parseFloat on every call. */
const DEFAULT_CHANGE_TINT = '#3b82f6'  // blue — reload-sourced change regions without explicit tint

function applyTinting(cache: { el: SVGTextElement; y: number }[], highlights: ChangeRegion[]) {
  // Reset all (skip elements being flash-tinted by highlighterSnap)
  for (let i = 0; i < cache.length; i++) {
    const t = cache[i].el
    if (t.hasAttribute('data-hl-tint')) continue
    t.removeAttribute('data-tinted')
    t.style.removeProperty('fill')
  }

  if (highlights.length === 0) return

  for (let i = 0; i < cache.length; i++) {
    if (cache[i].el.hasAttribute('data-hl-tint')) continue
    const ty = cache[i].y
    for (const r of highlights) {
      if (ty >= r.y && ty <= r.y + r.height) {
        cache[i].el.style.fill = r.tint || DEFAULT_CHANGE_TINT
        cache[i].el.setAttribute('data-tinted', '1')
        break
      }
    }
  }
}
