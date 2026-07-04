import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  useEditor,
  useValue,
} from 'tldraw'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { probe } from '../perf-probe'
import { injectSvgFonts } from '../svgFonts'
import { LineNumberOverlay } from '../LineNumberOverlay'
import { injectWordSpaces } from '../svgWordSpaces'
import { subscribeSvgText, getSvgText, setSvgText } from '../stores/svgTextStore'
import { changeStore, onShapeChangeUpdate, type ChangeRegion } from '../stores/changeStore'
import { anchorIndex, getNavigateToAnchor } from '../stores/anchorIndex'
import { svgViewBoxStore } from '../stores/svgViewBoxStore'
import { getPageUrl, getPageFilename } from '../stores/pageUrlStore'

export class SvgPageShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'svg-page' as const
  static override props = {
    w: T.number,
    h: T.number,
    pageIndex: T.number,
    version: T.optional(T.number),
    compareRef: T.optional(T.string),
    compareHash7: T.optional(T.string),
  }

  getDefaultProps() {
    return { w: 800, h: 1035, pageIndex: 0 }
  }

  canSelect = () => false
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

  getIndicatorPath(shape: any) {
    const path = new Path2D()
    path.rect(0, 0, shape.props.w, shape.props.h)
    return path
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

const BLUE_LINK_RE = /^(?:\d+(?:\.\d+)*|[A-Z](?:\.?\d+)*)$/

function installSyntheticRefLinks(svgEl: SVGSVGElement) {
  const candidates = svgEl.querySelectorAll<SVGElement>('text[fill], tspan[fill]')
  for (const el of candidates) {
    const fill = (el.getAttribute('fill') || '').toLowerCase()
    if (
      fill !== '#00f' && fill !== '#0000ff' && fill !== 'blue' && fill !== 'rgb(0,0,255)' &&
      fill !== '#0ff' && fill !== '#00ffff' && fill !== 'cyan' && fill !== 'rgb(0,255,255)'
    ) continue

    const label = (el.textContent || '').trim()
    if (!BLUE_LINK_RE.test(label)) continue

    el.setAttribute('data-anchor', label)
    el.setAttribute('data-title', label)
    el.style.cursor = 'pointer'
    el.style.pointerEvents = 'all'
  }
}

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

  const docName = new URLSearchParams(window.location.search).get('doc') || ''

  // Subscribe to reactive SVG text store
  const svgText = useSyncExternalStore(
    (cb) => subscribeSvgText(shape.id, cb),
    () => getSvgText(shape.id),
  )

  // Auto-fetch SVG for compare pages: compare shapes sync via Yjs but
  // the SVG text lives in a local JS Map that doesn't sync. Each browser
  // must independently fetch the SVGs. The compare ref is persisted on the
  // shape; the old signal-cache lookup is only for pre-migration shapes.
  useEffect(() => {
    if (svgText) return  // already have it
    const idStr = shape.id as string
    const propHash7 = shape.props.compareHash7 || shape.props.compareRef?.slice(0, 7)
    if (!propHash7 && !idStr.includes('compare-page-')) return  // not a compare page
    // The shape's pageIndex tells us which page to fetch (0-based → page-N.svg is 1-based)
    const pageIdx = shape.props.pageIndex
    const fetchCompare = async () => {
      try {
        const docName = new URLSearchParams(window.location.search).get('doc') || 'bregman'
        let hash7 = propHash7
        if (!hash7) {
          const sigRes = await fetch(`/api/projects/${docName}/signal/signal:compare`)
          if (!sigRes.ok) return
          const sig = await sigRes.json()
          const ref = sig?.data?.ref
          if (!ref) return
          hash7 = ref.slice(0, 7)
        }
        const filename = getPageFilename(pageIdx) ?? `page-${pageIdx + 1}.svg`
        const url = `/docs/${docName}/history/shadow-${hash7}/${filename}`
        const res = await fetch(url)
        if (!res.ok) return
        const text = await res.text()
        setSvgText(shape.id as string, text)
      } catch {}
    }
    fetchCompare()
  }, [shape.id, shape.props.compareHash7, shape.props.compareRef, shape.props.pageIndex, svgText])

  // Track what's currently injected so we skip redundant DOM work
  const injectedRef = useRef<string | null>(null)
  // Cached text element Y-positions for fast tinting (rebuilt on SVG injection)
  const textYCacheRef = useRef<{ el: SVGTextElement; y: number }[]>([])


  // Track whether this page is vertically near the viewport (±2 pages buffer).
  // Horizontal panning should not unload/reload page SVGs.
  const isNearViewport = useValue('near-viewport-' + shape.id, () => {
    const viewport = editor.getViewportPageBounds()
    const b = editor.getShapePageBounds(shape.id)
    if (!b) return false
    const marginY = b.h * VIEWPORT_BUFFER_PAGES
    return b.y + b.h > viewport.minY - marginY && b.y < viewport.maxY + marginY
  }, [editor, shape.id])

  // Fetch SVG when page enters the viewport — handles both initial load and re-entry.
  // On first entry (no svgText): fetch the SVG.
  // On re-entry (svgText exists): re-fetch to pick up any builds that happened while off-screen.
  // Abort in-flight fetches when the page leaves the viewport (prevents backlog on fast scroll).
  // Skip compare pages — they have their own fetch logic above.
  const prevIsNearViewportRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  useEffect(() => {
    const wasNear = prevIsNearViewportRef.current
    prevIsNearViewportRef.current = isNearViewport

    // Page left viewport — cancel any in-flight fetch
    if (!isNearViewport) {
      if (abortRef.current) { abortRef.current.abort(); abortRef.current = null }
      return
    }

    // Only act on false→true transitions
    if (wasNear) return

    const idStr = shape.id as string
    if (idStr.includes('col-') || idStr.includes('compare-page-')) return

    const docName = new URLSearchParams(window.location.search).get('doc')
    if (!docName) return

    // Abort previous fetch if still in flight
    if (abortRef.current) abortRef.current.abort()
    const controller = new AbortController()
    abortRef.current = controller

    const url = getPageUrl(shape.props.pageIndex)
    if (!url) return
    fetch(url, { signal: controller.signal }).then(async res => {
      if (!res.ok) return
      const newText = await res.text()
      if (newText !== svgText) setSvgText(shape.id as string, newText)
      // Populate anchorIndex and viewBox store from <view> elements.
      // Enables ref-click navigation for pages that haven't been through a reload cycle.
      const parser = new DOMParser()
      const svgDoc = parser.parseFromString(newText, 'image/svg+xml')
      const svgEl = svgDoc.querySelector('svg')
      if (svgEl) {
        const vb = svgEl.getAttribute('viewBox')
        if (vb) {
          const parts = vb.split(/\s+/).map(Number)
          if (parts.length === 4) {
            svgViewBoxStore.set(shape.id as string, { minX: parts[0], minY: parts[1], width: parts[2], height: parts[3] })
          }
        }
      }
      for (const view of svgDoc.querySelectorAll('view')) {
        const id = view.getAttribute('id')
        if (id) {
          anchorIndex.set(id, { pageShapeId: shape.id as string, viewBox: view.getAttribute('viewBox') || undefined })
        }
      }
    }).catch(e => { if (e.name !== 'AbortError') console.warn('[svg-page] anchor index build failed:', e.message) })
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

    const svgInjectTimer = probe.start('svg', 'svg-inject')
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
          const wsTimer = probe.start('svg', 'svg-word-spaces')
          injectWordSpaces(svgEl)
          probe.stop(wsTimer, { shapeId: shape.id, pageIndex: shape.props.pageIndex })
          // Cache the fully-processed HTML so scroll-back re-injection is instant
          processedSvgCache.set(shape.id, { svgText: capturedSvgText, html: el.innerHTML })
          // Final step of rendering a new page image: force its layout now, on
          // the FINISHED svg (after the word-space mutation that would otherwise
          // invalidate an earlier layout). Laying out a page of math (~700
          // positioned glyphs) costs ~250-300ms; doing it here — as the tail of
          // the render pipeline, off-screen in the prefetch buffer — means the
          // result is cached, so scrolling the page into view (an ancestor
          // transform) is free instead of freezing. Runs once per new image
          // (this effect only fires when svgText changes).
          const bboxTimer = probe.start('svg', 'svg-getBBox')
          try { svgEl.getBBox() } catch { /* not layable yet — harmless */ }
          probe.stop(bboxTimer, { shapeId: shape.id, pageIndex: shape.props.pageIndex })
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
    if (svgEl) installSyntheticRefLinks(svgEl)

    // Apply any pending tint highlights
    applyTinting(textYCacheRef.current, highlights)
    probe.stop(svgInjectTimer, { shapeId: shape.id, pageIndex: shape.props.pageIndex, cached: !!cacheEntry })
  }, [isNearViewport, svgText])

  // Anchor navigation (links inside the SVG) — click events do reach via link targets.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const onClick = (e: MouseEvent) => {
      if (e.metaKey) return
      const target = (e.target as Element).closest('[data-anchor]')
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
    return () => {
      el.removeEventListener('click', onClick)
    }
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
        {docName && isNearViewport && (
          <LineNumberOverlay
            docName={docName}
            pageNum={shape.props.pageIndex + 1}
            shapeH={shape.props.h}
            containerRef={containerRef}
            svgText={svgText}
          />
        )}
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
