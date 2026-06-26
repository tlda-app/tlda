/**
 * SlidesNavigator — touch-friendly slide navigation for spatial canvas slides.
 *
 * Features:
 * - Next/prev buttons (44px+ tap targets)
 * - Fragment advancement within slides before moving to next
 * - Swipe gesture support (horizontal)
 * - Slide counter display
 * - Animated camera transitions between slides
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { type Editor, type TLShapeId } from 'tldraw'
import type { SvgDocument, SlideInfo } from './svgDocumentLoader'
import { getPref, subscribePref } from './preferences'
import { broadcastSlideFragment, broadcastSlideIndex, onSlideFragment, onSlideIndex } from './useYjsSync'
import { getRole } from './viewerRole'

interface SlidesNavigatorProps {
  editor: Editor
  document: SvgDocument
}

// Fragment state per slide, keyed by shape ID
const fragmentState = new Map<string, { total: number; current: number }>()

type SlidesNavigationMode = 'inline-fragments' | 'orthogonal-fragments'

type HtmlPageShape = {
  id: TLShapeId
  type: 'html-page'
  props: { url?: string }
} & Record<string, unknown>

function isHtmlPageShape(shape: unknown): shape is HtmlPageShape {
  return typeof shape === 'object' && shape !== null && 'type' in shape && shape.type === 'html-page'
}

/** Navigate camera to center on a specific slide */
function navigateToSlide(editor: Editor, document: SvgDocument, animate = true) {
  const page = document.pages[0]
  if (!page) return
  const vp = editor.getViewportScreenBounds()
  // Presentation mode preserves slide scale by fitting width only. Tall slides
  // are allowed to overflow vertically on the TLDraw canvas.
  const z = Math.min(1, vp.width / page.width)
  const target = {
    x: -page.bounds.x + (vp.width / z - page.width) / 2,
    y: -page.bounds.y,
    z,
  }
  if (animate) {
    editor.setCamera(target, { animation: { duration: 350 } })
  } else {
    editor.setCamera(target)
  }
}

function getSlides(document: SvgDocument): SlideInfo[] {
  return document.slideInfo && document.slideInfo.length > 0
    ? document.slideInfo
    : document.pages.map((page, i) => ({
      file: page.src,
      width: page.width,
      height: page.height,
      slideIndex: i,
      indexh: i,
      indexv: 0,
    }))
}

function slideIndexFromCoords(slides: SlideInfo[], indexh: number, indexv: number): number {
  const idx = slides.findIndex(slide =>
    (slide.indexh ?? slide.slideIndex) === indexh &&
    (slide.indexv ?? 0) === indexv
  )
  return idx >= 0 ? idx : 0
}

function getDeckShapeId(document: SvgDocument): string | null {
  return document.pages[0]?.shapeId ?? null
}

function deckIframe(document: SvgDocument): HTMLIFrameElement | null {
  const shapeId = getDeckShapeId(document)
  if (!shapeId) return null
  return window.document.querySelector(`[data-shape-id="${shapeId}"] iframe`) as HTMLIFrameElement | null
}

function goToDeckSlide(document: SvgDocument, slide: SlideInfo): boolean {
  const el = deckIframe(document)
  if (!el?.contentWindow) return false
  el.contentWindow.postMessage({
    type: 'tlda-slide-goto',
    indexh: slide.indexh ?? slide.slideIndex,
    indexv: slide.indexv ?? 0,
  }, '*')
  return true
}

/** Send fragment step message to the slide's iframe */
function stepFragment(document: SvgDocument, direction: 'next' | 'prev'): boolean {
  const el = deckIframe(document)
  if (!el?.contentWindow) return false
  el.contentWindow.postMessage({
    type: direction === 'next' ? 'tlda-fragment-next' : 'tlda-fragment-prev',
  }, '*')
  return true
}

function setDeckFragmentCount(document: SvgDocument, current: number): boolean {
  const el = deckIframe(document)
  if (!el?.contentWindow) return false
  el.contentWindow.postMessage({
    type: 'tlda-fragment-goto',
    current,
  }, '*')
  return true
}

function reconcileFragment(document: SvgDocument, shapeId: string, targetCurrent: number): boolean {
  const fs = fragmentState.get(shapeId)
  if (!fs) return false
  const delta = targetCurrent - fs.current
  if (delta === 0) return true
  const direction = delta > 0 ? 'next' : 'prev'
  let sent = false
  for (let i = 0; i < Math.abs(delta); i++) {
    sent = stepFragment(document, direction) || sent
  }
  return sent
}

export function SlidesNavigator({ editor, document }: SlidesNavigatorProps) {
  const [currentSlide, setCurrentSlide] = useState(0)
  const [fragmentInfo, setFragmentInfo] = useState<{ current: number; total: number } | null>(null)
  const [navigationMode, setNavigationMode] = useState<SlidesNavigationMode>(() => getPref('slides-navigation-mode'))
  const slides = useMemo(() => getSlides(document), [document])
  const totalSlides = slides.length
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null)
  const pendingRemoteFragmentsRef = useRef(new Map<string, number>())
  const applyingRemoteFragmentRef = useRef(false)
  const applyingRemoteSlideRef = useRef(false)
  const orthogonalFragments = navigationMode === 'orthogonal-fragments'

  useEffect(() => {
    return subscribePref(() => setNavigationMode(getPref('slides-navigation-mode')))
  }, [])

  useEffect(() => {
    const removeStaleSlidePages = () => {
      const deckShapeId = getDeckShapeId(document)
      const currentShapes: unknown[] = editor.getCurrentPageShapes()
      const staleSlidePages: HtmlPageShape[] = []
      for (const shape of currentShapes) {
        if (
          isHtmlPageShape(shape) &&
          shape.id !== deckShapeId &&
          shape.props.url?.includes('_tldaH=')
        ) {
          staleSlidePages.push(shape)
        }
      }
      if (staleSlidePages.length > 0) {
        editor.store.remove(staleSlidePages.map((shape) => shape.id))
      }
    }
    removeStaleSlidePages()
    return editor.store.listen(removeStaleSlidePages, { source: 'all', scope: 'document' })
  }, [editor, document])

  // Listen for fragment state reports from iframes
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'tlda-fragment-state') {
        const { shapeId, current, total, indexh = 0, indexv = 0 } = e.data
        fragmentState.set(shapeId, { total, current })
        const pending = pendingRemoteFragmentsRef.current.get(shapeId)
        if (pending !== undefined && pending !== current) {
          if (reconcileFragment(document, shapeId, pending)) return
        }
        pendingRemoteFragmentsRef.current.delete(shapeId)
        if (shapeId === getDeckShapeId(document)) {
          const idx = slideIndexFromCoords(slides, indexh, indexv)
          if (idx !== currentSlide) setCurrentSlide(idx)
          setFragmentInfo({ current, total })
        }
        if (!applyingRemoteFragmentRef.current && getRole() === 'presenter') {
          broadcastSlideFragment(shapeId, current, total)
        }
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [currentSlide, document, slides])

  useEffect(() => {
    return onSlideFragment((signal) => {
      if (getRole() !== 'viewer') return
      applyingRemoteFragmentRef.current = true
      pendingRemoteFragmentsRef.current.set(signal.shapeId, signal.current)
      const applied = reconcileFragment(document, signal.shapeId, signal.current)
      if (applied) {
        const fs = fragmentState.get(signal.shapeId)
        if (fs) {
          setFragmentInfo({ current: signal.current, total: signal.total })
        }
      }
      setTimeout(() => { applyingRemoteFragmentRef.current = false }, 250)
    })
  }, [document])

  // On mount: fix stale opacity and navigate to the single deck page
  useEffect(() => {
    for (let i = 0; i < document.pages.length; i++) {
      const page = document.pages[i]
      const shape = editor.store.get(page.shapeId)
      if (!shape) continue
      const updates: Record<string, unknown> = {}
      if (shape.opacity !== 1) updates.opacity = 1
      if (Object.keys(updates).length > 0) {
        editor.store.update(page.shapeId, (s) => ({ ...s, ...updates }))
      }
    }
    navigateToSlide(editor, document, false)
    if (slides[0]) goToDeckSlide(document, slides[0])
    window.document.body.classList.add('slides-mode')
    return () => {
      window.document.body.classList.remove('slides-mode')
      window.document.documentElement.style.removeProperty('--tlda-slide-background')
    }
  }, [editor, document, slides])

  const goToSlide = useCallback((index: number, animate = true) => {
    const clamped = Math.max(0, Math.min(index, totalSlides - 1))
    setCurrentSlide(clamped)
    navigateToSlide(editor, document, animate)
    setFragmentInfo(null)
    if (slides[clamped]) goToDeckSlide(document, slides[clamped])
    const shapeId = getDeckShapeId(document)
    if (!applyingRemoteSlideRef.current && shapeId && getRole() === 'presenter') {
      broadcastSlideIndex(shapeId, clamped)
    }
  }, [editor, document, totalSlides, slides])

  useEffect(() => {
    return onSlideIndex((signal) => {
      if (getRole() !== 'viewer') return
      if (signal.shapeId !== getDeckShapeId(document)) return
      applyingRemoteSlideRef.current = true
      goToSlide(signal.index)
      setTimeout(() => { applyingRemoteSlideRef.current = false }, 250)
    })
  }, [document, goToSlide])

  useEffect(() => {
    const refitCurrentSlide = () => {
      goToSlide(currentSlide, false)
    }
    window.addEventListener('resize', refitCurrentSlide)
    window.visualViewport?.addEventListener('resize', refitCurrentSlide)
    return () => {
      window.removeEventListener('resize', refitCurrentSlide)
      window.visualViewport?.removeEventListener('resize', refitCurrentSlide)
    }
  }, [currentSlide, goToSlide])

  const handleNext = useCallback(() => {
    const shapeId = getDeckShapeId(document)
    if (!shapeId) return
    if (orthogonalFragments) {
      if (currentSlide < totalSlides - 1) goToSlide(currentSlide + 1)
      return
    }
    // Try advancing fragment first
    const fs = fragmentState.get(shapeId)
    if (fs && fs.current < fs.total) {
      stepFragment(document, 'next')
      return
    }
    // No more fragments — go to next slide
    if (currentSlide < totalSlides - 1) {
      goToSlide(currentSlide + 1)
    }
  }, [currentSlide, totalSlides, document, goToSlide, orthogonalFragments])

  const handlePrev = useCallback(() => {
    const shapeId = getDeckShapeId(document)
    if (!shapeId) return
    if (orthogonalFragments) {
      if (currentSlide > 0) goToSlide(currentSlide - 1)
      return
    }
    // Try going back a fragment first
    const fs = fragmentState.get(shapeId)
    if (fs && fs.current > 0) {
      stepFragment(document, 'prev')
      return
    }
    // No more fragments back — go to prev slide
    if (currentSlide > 0) {
      goToSlide(currentSlide - 1)
    }
  }, [currentSlide, document, goToSlide, orthogonalFragments])

  const setFragmentCurrent = useCallback((target: number) => {
    const shapeId = getDeckShapeId(document)
    if (!shapeId) return
    const fs = fragmentState.get(shapeId)
    const total = fs?.total ?? fragmentInfo?.total ?? 0
    if (total <= 0) return
    const current = Math.max(0, Math.min(target, total))
    if (setDeckFragmentCount(document, current)) {
      fragmentState.set(shapeId, { total, current })
      setFragmentInfo({ total, current })
      if (!applyingRemoteFragmentRef.current && getRole() === 'presenter') {
        broadcastSlideFragment(shapeId, current, total)
      }
    }
  }, [document, fragmentInfo])

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ') {
        e.preventDefault()
        handleNext()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        handlePrev()
      } else if (orthogonalFragments && e.key === 'ArrowDown') {
        e.preventDefault()
        setFragmentCurrent((fragmentInfo?.current ?? 0) + 1)
      } else if (orthogonalFragments && e.key === 'ArrowUp') {
        e.preventDefault()
        setFragmentCurrent((fragmentInfo?.current ?? 0) - 1)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleNext, handlePrev, orthogonalFragments, setFragmentCurrent, fragmentInfo])

  // Touch swipe handling
  const startTouch = useCallback((touch: Touch) => {
    touchStartRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() }
  }, [])

  const endTouch = useCallback((touch: Touch) => {
    if (!touchStartRef.current) return
    const dx = touch.clientX - touchStartRef.current.x
    const dy = touch.clientY - touchStartRef.current.y
    const dt = Date.now() - touchStartRef.current.time
    touchStartRef.current = null

    // Require: horizontal > vertical, min 50px, max 800ms
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 50 && dt < 800) {
      if (dx < 0) handleNext()
      else handlePrev()
    }
  }, [handleNext, handlePrev])

  useEffect(() => {
    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      startTouch(e.touches[0])
    }
    const handleTouchEnd = (e: TouchEvent) => {
      if (e.changedTouches.length !== 1) return
      endTouch(e.changedTouches[0])
    }
    window.addEventListener('touchstart', handleTouchStart, { passive: true })
    window.addEventListener('touchend', handleTouchEnd, { passive: true })
    return () => {
      window.removeEventListener('touchstart', handleTouchStart)
      window.removeEventListener('touchend', handleTouchEnd)
    }
  }, [startTouch, endTouch])

  const containerStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 999,
    pointerEvents: 'none',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    touchAction: 'none',
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    fontSize: 14,
  }

  const btnStyle: React.CSSProperties = {
    width: 42,
    height: 72,
    borderRadius: 999,
    border: 'none',
    background: 'transparent',
    boxShadow: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 20,
    color: 'var(--color-text, #333)',
    transition: 'background 0.15s, opacity 0.15s',
    WebkitTapHighlightColor: 'transparent',
    pointerEvents: 'auto',
    position: 'fixed',
    top: '50%',
    transform: 'translateY(-50%)',
    opacity: 0.14,
  }

  const disabledBtnStyle: React.CSSProperties = {
    ...btnStyle,
    opacity: 0.1,
    cursor: 'default',
  }

  const isFirst = currentSlide === 0 && (orthogonalFragments || !fragmentInfo || fragmentInfo.current === 0)
  const isLast = currentSlide === totalSlides - 1 && (orthogonalFragments || !fragmentInfo || fragmentInfo.current >= fragmentInfo.total)
  const showFragmentSlider = orthogonalFragments && fragmentInfo && fragmentInfo.total > 0

  const nav = (
    <div
      style={containerStyle}
      className="slides-navigator"
    >
      <button
        className="slides-nav-button slides-nav-button--prev"
        style={{ ...(isFirst ? disabledBtnStyle : btnStyle), left: 'max(72px, calc(env(safe-area-inset-left) + 72px))' }}
        onClick={handlePrev}
        disabled={isFirst}
        aria-label="Previous"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>
      <span className="slides-nav-counter">
        {currentSlide + 1} / {totalSlides}
        {fragmentInfo && fragmentInfo.total > 0 && (
          <span style={{ fontSize: 11, opacity: 0.65, marginLeft: 4 }}>
            ({fragmentInfo.current}/{fragmentInfo.total})
          </span>
        )}
      </span>
      <button
        className="slides-nav-button slides-nav-button--next"
        style={{ ...(isLast ? disabledBtnStyle : btnStyle), right: 'max(12px, calc(env(safe-area-inset-right) + 12px))' }}
        onClick={handleNext}
        disabled={isLast}
        aria-label="Next"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </button>
      {showFragmentSlider && (
        <input
          className="slides-fragment-slider"
          type="range"
          min={0}
          max={fragmentInfo.total}
          step={1}
          value={fragmentInfo.current}
          onChange={e => setFragmentCurrent(Number(e.target.value))}
          aria-label="Fragment"
        />
      )}
    </div>
  )

  // Swipe detection overlay — transparent, covers the canvas, captures horizontal swipes
  // while letting vertical + short touches through to TLDraw
  return createPortal(
    <>
      {nav}
      <style>{`
        .slides-navigator button:active {
          background: transparent !important;
          opacity: 0.7 !important;
        }
        .slides-navigator button:hover {
          opacity: 0.6 !important;
        }
        .slides-nav-counter {
          position: fixed;
          left: 50%;
          bottom: max(10px, env(safe-area-inset-bottom));
          transform: translateX(-50%);
          min-width: 72px;
          min-height: 30px;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 4px 10px;
          border-radius: 999px;
          background: rgba(255,255,255,0.86);
          box-shadow: 0 2px 10px rgba(0,0,0,0.12);
          color: var(--color-text, #333);
          pointer-events: none;
          opacity: 0.82;
        }
        .slides-fragment-slider {
          position: fixed;
          right: max(54px, calc(env(safe-area-inset-right) + 54px));
          top: 50%;
          width: 96px;
          height: 24px;
          transform: translateY(-50%) rotate(-90deg);
          transform-origin: center;
          pointer-events: auto;
          accent-color: var(--color-text, #333);
          opacity: 0.34;
          transition: opacity 0.15s;
          touch-action: none;
        }
        .slides-fragment-slider:hover,
        .slides-fragment-slider:active {
          opacity: 0.68;
        }
        .tl-theme__dark .slides-navigator {
          color: #e0e0e0 !important;
        }
        .tl-theme__dark .slides-navigator button {
          color: #e0e0e0 !important;
          background: transparent !important;
        }
        .tl-theme__dark .slides-navigator button:active {
          background: transparent !important;
        }
        .tl-theme__dark .slides-nav-counter {
          background: rgba(30,30,30,0.82) !important;
          color: #e0e0e0 !important;
        }
        .tl-theme__dark .slides-fragment-slider {
          accent-color: #e0e0e0;
        }
        @media (max-width: 900px), (pointer: coarse) {
          .slides-nav-button {
            width: 44px !important;
            height: 84px !important;
          }
          .slides-nav-counter {
            bottom: max(8px, env(safe-area-inset-bottom));
          }
        }
        body.slides-mode .tl-background,
        body.slides-mode .tl-container {
          background: var(--tlda-slide-background, #fff) !important;
        }
      `}</style>
    </>,
    window.document.body,
  )
}
