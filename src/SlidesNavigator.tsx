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

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { type Editor, Box } from 'tldraw'
import type { SvgDocument } from './svgDocumentLoader'
import { SLIDE_GAP } from './loaders/slidesLoader'

interface SlidesNavigatorProps {
  editor: Editor
  document: SvgDocument
}

// Fragment state per slide, keyed by shape ID
const fragmentState = new Map<string, { total: number; current: number }>()

/** Navigate camera to center on a specific slide */
function navigateToSlide(editor: Editor, document: SvgDocument, index: number, animate = true) {
  const page = document.pages[index]
  if (!page) return
  const vp = editor.getViewportScreenBounds()
  // Contain: fit whole slide in viewport. Gap is large enough to hide neighbors.
  const z = Math.min(vp.width / page.width, vp.height / page.height)
  const target = {
    x: -page.bounds.x + (vp.width / z - page.width) / 2,
    y: -page.bounds.y + (vp.height / z - page.height) / 2,
    z,
  }
  if (animate) {
    editor.setCamera(target, { animation: { duration: 350 } })
  } else {
    editor.setCamera(target)
  }
}

/** Determine which slide the camera is currently closest to */
function getCurrentSlideIndex(editor: Editor, document: SvgDocument): number {
  const cam = editor.getCamera()
  const vp = editor.getViewportScreenBounds()
  // Camera x maps to canvas x via: canvasX = -cam.x + vp.width / (2 * cam.z)
  const viewCenterX = -cam.x + vp.width / (2 * cam.z)

  let bestIdx = 0
  let bestDist = Infinity
  for (let i = 0; i < document.pages.length; i++) {
    const page = document.pages[i]
    const slideCenterX = page.bounds.x + page.width / 2
    const dist = Math.abs(viewCenterX - slideCenterX)
    if (dist < bestDist) {
      bestDist = dist
      bestIdx = i
    }
  }
  return bestIdx
}

/** Send fragment step message to the slide's iframe */
function stepFragment(_editor: Editor, shapeId: string, direction: 'next' | 'prev'): boolean {
  const el = window.document.querySelector(`[data-shape-id="${shapeId}"] iframe`) as HTMLIFrameElement
  if (!el?.contentWindow) return false
  el.contentWindow.postMessage({
    type: direction === 'next' ? 'tlda-fragment-next' : 'tlda-fragment-prev',
  }, '*')
  return true
}

export function SlidesNavigator({ editor, document }: SlidesNavigatorProps) {
  const [currentSlide, setCurrentSlide] = useState(0)
  const [fragmentInfo, setFragmentInfo] = useState<{ current: number; total: number } | null>(null)
  const totalSlides = document.pages.length
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null)
  const navigatingRef = useRef(false)

  // Listen for fragment state reports from iframes
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'tlda-fragment-state') {
        const { shapeId, current, total } = e.data
        fragmentState.set(shapeId, { total, current })
        // Update display if this is the current slide
        const currentPage = document.pages[currentSlide]
        if (currentPage && shapeId === currentPage.shapeId) {
          setFragmentInfo({ current, total })
        }
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [currentSlide, document.pages])

  // On mount: fix stale opacity, reposition slides with correct gap, navigate to slide 0
  useEffect(() => {
    for (let i = 0; i < document.pages.length; i++) {
      const page = document.pages[i]
      const shape = editor.store.get(page.shapeId)
      if (!shape) continue
      const targetX = i * (page.width + SLIDE_GAP)
      const updates: Record<string, unknown> = {}
      if (shape.opacity !== 1) updates.opacity = 1
      if (shape.x !== targetX) updates.x = targetX
      if (Object.keys(updates).length > 0) {
        editor.store.update(page.shapeId, (s) => ({ ...s, ...updates }))
      }
      // Update document.pages bounds to match new positions
      page.bounds = new Box(targetX, 0, page.width, page.height)
    }
    navigateToSlide(editor, document, 0, false)
    window.document.body.classList.add('slides-mode')
    // Make slide iframe backgrounds transparent
    const makeTransparent = () => {
      const iframes = window.document.querySelectorAll('[data-shape-id] iframe') as NodeListOf<HTMLIFrameElement>
      for (const iframe of iframes) {
        try {
          const doc = iframe.contentDocument
          if (!doc) continue
          if (!doc.getElementById('tlda-slide-bg')) {
            const style = doc.createElement('style')
            style.id = 'tlda-slide-bg'
            style.textContent = '.reveal, .reveal .slide-background, .reveal .slide-background-content, body { background: transparent !important; }'
            doc.head.appendChild(style)
          }
        } catch {}
      }
    }
    // Retry since iframes load async
    makeTransparent()
    const timer = setInterval(makeTransparent, 1000)
    setTimeout(() => clearInterval(timer), 10000)
    return () => { clearInterval(timer); window.document.body.classList.remove('slides-mode') }
  }, [editor, document])

  // Track camera position to update current slide indicator
  useEffect(() => {
    let rafId: number
    const checkSlide = () => {
      if (navigatingRef.current) return
      const idx = getCurrentSlideIndex(editor, document)
      if (idx !== currentSlide) {
        setCurrentSlide(idx)
        const page = document.pages[idx]
        if (page) {
          const fs = fragmentState.get(page.shapeId)
          setFragmentInfo(fs || null)
        }
      }
    }
    const unsub = editor.store.listen(() => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(checkSlide)
    }, { source: 'all', scope: 'session' })
    return () => { unsub(); cancelAnimationFrame(rafId) }
  }, [editor, document, currentSlide])

  const goToSlide = useCallback((index: number, animate = true) => {
    const clamped = Math.max(0, Math.min(index, totalSlides - 1))
    navigatingRef.current = true
    setCurrentSlide(clamped)
    navigateToSlide(editor, document, clamped, animate)
    // Update fragment info for new slide
    const page = document.pages[clamped]
    if (page) {
      const fs = fragmentState.get(page.shapeId)
      setFragmentInfo(fs || null)
    }
    setTimeout(() => { navigatingRef.current = false }, 400)
  }, [editor, document, totalSlides])

  const handleNext = useCallback(() => {
    const page = document.pages[currentSlide]
    if (!page) return
    // Try advancing fragment first
    const fs = fragmentState.get(page.shapeId)
    if (fs && fs.current < fs.total) {
      stepFragment(editor, page.shapeId, 'next')
      return
    }
    // No more fragments — go to next slide
    if (currentSlide < totalSlides - 1) {
      goToSlide(currentSlide + 1)
    }
  }, [currentSlide, totalSlides, editor, document.pages, goToSlide])

  const handlePrev = useCallback(() => {
    const page = document.pages[currentSlide]
    if (!page) return
    // Try going back a fragment first
    const fs = fragmentState.get(page.shapeId)
    if (fs && fs.current > 0) {
      stepFragment(editor, page.shapeId, 'prev')
      return
    }
    // No more fragments back — go to prev slide
    if (currentSlide > 0) {
      goToSlide(currentSlide - 1)
    }
  }, [currentSlide, editor, document.pages, goToSlide])

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ') {
        e.preventDefault()
        handleNext()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        handlePrev()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleNext, handlePrev])

  // Touch swipe handling
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]
    touchStartRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() }
  }, [])

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!touchStartRef.current) return
    const touch = e.changedTouches[0]
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

  const containerStyle: React.CSSProperties = {
    position: 'fixed',
    bottom: 20,
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '8px 16px',
    borderRadius: 12,
    background: 'var(--color-background, rgba(255,255,255,0.9))',
    boxShadow: '0 2px 12px rgba(0,0,0,0.15)',
    zIndex: 999,
    userSelect: 'none',
    WebkitUserSelect: 'none',
    touchAction: 'none',
    fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
    fontSize: 14,
  }

  const btnStyle: React.CSSProperties = {
    width: 48,
    height: 48,
    borderRadius: 8,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 20,
    color: 'var(--color-text, #333)',
    transition: 'background 0.15s',
    WebkitTapHighlightColor: 'transparent',
  }

  const disabledBtnStyle: React.CSSProperties = {
    ...btnStyle,
    opacity: 0.3,
    cursor: 'default',
  }

  const isFirst = currentSlide === 0 && (!fragmentInfo || fragmentInfo.current === 0)
  const isLast = currentSlide === totalSlides - 1 && (!fragmentInfo || fragmentInfo.current >= fragmentInfo.total)

  const nav = (
    <div
      style={containerStyle}
      className="slides-navigator"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <button
        style={isFirst ? disabledBtnStyle : btnStyle}
        onClick={handlePrev}
        disabled={isFirst}
        aria-label="Previous"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>
      <span style={{ minWidth: 80, textAlign: 'center', opacity: 0.7 }}>
        {currentSlide + 1} / {totalSlides}
        {fragmentInfo && fragmentInfo.total > 0 && (
          <span style={{ fontSize: 11, opacity: 0.5, marginLeft: 4 }}>
            ({fragmentInfo.current}/{fragmentInfo.total})
          </span>
        )}
      </span>
      <button
        style={isLast ? disabledBtnStyle : btnStyle}
        onClick={handleNext}
        disabled={isLast}
        aria-label="Next"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </button>
    </div>
  )

  // Swipe detection overlay — transparent, covers the canvas, captures horizontal swipes
  // while letting vertical + short touches through to TLDraw
  return createPortal(
    <>
      {nav}
      <style>{`
        .slides-navigator button:active {
          background: rgba(0,0,0,0.08) !important;
        }
        .tl-theme__dark .slides-navigator {
          background: rgba(30,30,30,0.95) !important;
          color: #e0e0e0 !important;
        }
        .tl-theme__dark .slides-navigator button {
          color: #e0e0e0 !important;
        }
        .tl-theme__dark .slides-navigator button:active {
          background: rgba(255,255,255,0.1) !important;
        }
        body.slides-mode .tl-background,
        body.slides-mode .tl-container {
          background: rgba(245, 240, 232, 0.1) !important;
        }
      `}</style>
    </>,
    window.document.body,
  )
}
