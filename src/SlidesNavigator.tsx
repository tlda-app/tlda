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
import { type Editor } from 'tldraw'
import type { SvgDocument } from './svgDocumentLoader'
import { broadcastSlideFragment, broadcastSlideIndex, onSlideFragment, onSlideIndex } from './useYjsSync'
import { getRole } from './viewerRole'

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

function getDeckSyncShapeId(document: SvgDocument): string | null {
  return document.pages[0]?.shapeId ?? null
}

function slideIframe(shapeId: string): HTMLIFrameElement | null {
  if (!shapeId) return null
  return window.document.querySelector(`[data-shape-id="${shapeId}"] iframe`) as HTMLIFrameElement | null
}

/** Send fragment step message to the slide's iframe */
function stepFragment(shapeId: string, direction: 'next' | 'prev'): boolean {
  const el = slideIframe(shapeId)
  if (!el?.contentWindow) return false
  el.contentWindow.postMessage({
    type: direction === 'next' ? 'tlda-fragment-next' : 'tlda-fragment-prev',
  }, '*')
  return true
}

function reconcileFragment(shapeId: string, targetCurrent: number): boolean {
  const fs = fragmentState.get(shapeId)
  if (!fs) return false
  const delta = targetCurrent - fs.current
  if (delta === 0) return true
  const direction = delta > 0 ? 'next' : 'prev'
  let sent = false
  for (let i = 0; i < Math.abs(delta); i++) {
    sent = stepFragment(shapeId, direction) || sent
  }
  return sent
}

export function SlidesNavigator({ editor, document }: SlidesNavigatorProps) {
  const [currentSlide, setCurrentSlide] = useState(0)
  const [fragmentInfo, setFragmentInfo] = useState<{ current: number; total: number } | null>(null)
  const totalSlides = document.pages.length
  const pendingRemoteFragmentsRef = useRef(new Map<string, number>())
  const applyingRemoteFragmentRef = useRef(false)
  const applyingRemoteSlideRef = useRef(false)
  // Listen for fragment state reports from iframes
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'tlda-fragment-state') {
        const { shapeId, current, total } = e.data
        fragmentState.set(shapeId, { total, current })
        const pending = pendingRemoteFragmentsRef.current.get(shapeId)
        if (pending !== undefined && pending !== current) {
          if (reconcileFragment(shapeId, pending)) return
        }
        pendingRemoteFragmentsRef.current.delete(shapeId)
        const pageIndex = document.pages.findIndex(page => page.shapeId === shapeId)
        if (pageIndex === currentSlide) {
          setFragmentInfo({ current, total })
          if (!applyingRemoteFragmentRef.current && getRole() === 'presenter') {
            broadcastSlideFragment(shapeId, current, total)
          }
        }
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [currentSlide, document])

  useEffect(() => {
    return onSlideFragment((signal) => {
      if (getRole() !== 'viewer') return
      applyingRemoteFragmentRef.current = true
      pendingRemoteFragmentsRef.current.set(signal.shapeId, signal.current)
      const applied = reconcileFragment(signal.shapeId, signal.current)
      if (applied) {
        const fs = fragmentState.get(signal.shapeId)
        if (fs) {
          setFragmentInfo({ current: signal.current, total: signal.total })
        }
      }
      setTimeout(() => { applyingRemoteFragmentRef.current = false }, 250)
    })
  }, [])

  // On mount: fix stale opacity and navigate to the first page
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
    navigateToSlide(editor, document, 0, false)
    window.document.body.classList.add('slides-mode')
    return () => {
      window.document.body.classList.remove('slides-mode')
      window.document.documentElement.style.removeProperty('--tlda-slide-background')
    }
  }, [editor, document])

  const goToSlide = useCallback((index: number, animate = true) => {
    const clamped = Math.max(0, Math.min(index, totalSlides - 1))
    setCurrentSlide(clamped)
    navigateToSlide(editor, document, clamped, animate)
    const page = document.pages[clamped]
    setFragmentInfo(page ? fragmentState.get(page.shapeId) ?? null : null)
    const shapeId = getDeckSyncShapeId(document)
    if (!applyingRemoteSlideRef.current && shapeId && getRole() === 'presenter') {
      broadcastSlideIndex(shapeId, clamped)
    }
  }, [editor, document, totalSlides, slides])

  useEffect(() => {
    return onSlideIndex((signal) => {
      if (getRole() !== 'viewer') return
      if (signal.shapeId !== getDeckSyncShapeId(document)) return
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
    const shapeId = document.pages[currentSlide]?.shapeId
    if (!shapeId) return
    // Try advancing fragment first
    const fs = fragmentState.get(shapeId)
    if (fs && fs.current < fs.total) {
      stepFragment(shapeId, 'next')
      return
    }
    // No more fragments — go to next slide
    if (currentSlide < totalSlides - 1) {
      goToSlide(currentSlide + 1)
    }
  }, [currentSlide, totalSlides, document, goToSlide])

  const handlePrev = useCallback(() => {
    const shapeId = document.pages[currentSlide]?.shapeId
    if (!shapeId) return
    // Try going back a fragment first
    const fs = fragmentState.get(shapeId)
    if (fs && fs.current > 0) {
      stepFragment(shapeId, 'prev')
      return
    }
    // No more fragments back — go to prev slide
    if (currentSlide > 0) {
      goToSlide(currentSlide - 1)
    }
  }, [currentSlide, document, goToSlide])

  const handleNextSlide = useCallback(() => {
    if (currentSlide < totalSlides - 1) goToSlide(currentSlide + 1)
  }, [currentSlide, totalSlides, goToSlide])

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

  const hasNextFragment = !!fragmentInfo && fragmentInfo.current < fragmentInfo.total
  const isFirst = currentSlide === 0 && (!fragmentInfo || fragmentInfo.current === 0)
  const isLast = currentSlide === totalSlides - 1 && !hasNextFragment
  const isLastSlide = currentSlide === totalSlides - 1

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
        style={{ ...(isLast ? disabledBtnStyle : btnStyle), right: 'max(54px, calc(env(safe-area-inset-right) + 54px))' }}
        onClick={handleNext}
        disabled={isLast}
        aria-label={hasNextFragment ? 'Next fragment' : 'Next slide'}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points={hasNextFragment ? '6 9 12 15 18 9' : '9 6 15 12 9 18'} />
        </svg>
      </button>
      <button
        className="slides-nav-button slides-nav-button--next-slide"
        style={{ ...(isLastSlide ? disabledBtnStyle : btnStyle), right: 'max(12px, calc(env(safe-area-inset-right) + 12px))' }}
        onClick={handleNextSlide}
        disabled={isLastSlide}
        aria-label="Next slide"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="7 6 13 12 7 18" />
          <line x1="17" y1="6" x2="17" y2="18" />
        </svg>
      </button>
    </div>
  )

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
