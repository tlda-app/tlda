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
import {
  deckPositionKey,
  fragmentKeyForReport,
  fragmentKeyForSlide,
  nextSlideAction,
  prevSlideAction,
  resolveInitialSlide,
} from './slidesFragmentState'

function readStoredSlide(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key)
  } catch {
    return null
  }
}

function storeSlide(key: string, index: number): void {
  try {
    window.sessionStorage.setItem(key, String(index))
  } catch {
    // Private mode etc: resume is a convenience, never a requirement.
  }
}

interface SlidesNavigatorProps {
  editor: Editor
  document: SvgDocument
}

// Fragment state per slide. A deck shares ONE shapeId across every slide, so the
// key is shape + reveal address (see slidesFragmentState); one shape per slide
// documents keep the plain shapeId key.
const fragmentState = new Map<string, { total: number; current: number }>()

function fragmentKeyForBox(box: { shapeId: string; indexh?: number; indexv?: number }): string {
  return fragmentKeyForSlide(box.shapeId, box.indexh, box.indexv)
}

/** Navigate camera to center on a specific slide */
/**
 * A deck is ONE page shape carrying every slide, so a slide is an address in it
 * rather than a page of its own. `deckLayout` holds the rect per address; the
 * old per-page path stays for anything that still arrives as separate pages.
 */
function slideBoxes(document: SvgDocument) {
  const deck = document.deckLayout?.rects
  const base = document.pages[0]
  if (deck?.length && base) {
    return deck.map(r => ({
      x: base.bounds.x + r.x,
      y: base.bounds.y + r.y,
      width: r.width,
      height: r.height,
      shapeId: base.shapeId,
      indexh: r.indexh,
      indexv: r.indexv,
    }))
  }
  return document.pages.map(page => ({
    x: page.bounds.x,
    y: page.bounds.y,
    width: page.width,
    height: page.height,
    shapeId: page.shapeId,
    indexh: undefined as number | undefined,
    indexv: undefined as number | undefined,
  }))
}

function navigateToSlide(editor: Editor, document: SvgDocument, index: number, animate = true) {
  const page = slideBoxes(document)[index]
  if (!page) return
  const vp = editor.getViewportScreenBounds()
  // Keep the whole slide visible and centered. Width-only fitting clips decks
  // whose authored aspect ratio is taller than the browser viewport, which
  // makes adjacent slides appear to jump between centered and cut off.
  const z = Math.min(1, vp.width / page.width, vp.height / page.height)
  const target = {
    x: -page.x + (vp.width / z - page.width) / 2,
    y: -page.y + (vp.height / z - page.height) / 2,
    z,
  }
  // Keep reveal's own address in step, so fragments and anything reading
  // getIndices() answer for the slide the camera is actually on.
  if (page.indexh !== undefined) {
    slideIframe(page.shapeId)?.contentWindow?.postMessage(
      { type: 'tlda-slide-goto', indexh: page.indexh, indexv: page.indexv ?? 0 }, '*',
    )
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
  // The main canvas's copy, not a clip panel's. The same page shape can be
  // rendered again inside a fleet-docview or an annotation viewer — each is its
  // own viewport over the same store — and then this shape id matches more than
  // one iframe. `querySelector` would take whichever came first in document
  // order, and posting a fragment step into a panel's copy fails silently:
  // `.fleet-hud-wrap iframe` is `pointer-events: none`, but a `contentWindow` is
  // still perfectly drivable, so the deck the reader is looking at simply does
  // not advance.
  //
  // A clip panel puts `data-viewport-id` on its container (`CanvasClipPanel`),
  // so the main canvas is the copy with no such ancestor. Returning null when
  // only a panel's copy exists is the honest answer: the navigator drives the
  // deck on the canvas, and there isn't one.
  const candidates = window.document.querySelectorAll<HTMLIFrameElement>(`[data-shape-id="${shapeId}"] iframe`)
  for (const el of candidates) {
    if (!el.closest('[data-viewport-id]')) return el
  }
  return null
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

function reconcileFragment(shapeId: string, key: string, targetCurrent: number): boolean {
  const fs = fragmentState.get(key)
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
  const totalSlides = document.deckLayout?.rects?.length || document.pages.length
  const pendingRemoteFragmentsRef = useRef(new Map<string, number>())
  const applyingRemoteFragmentRef = useRef(false)
  const applyingRemoteSlideRef = useRef(false)
  // The viewer's current slide key for incoming fragment sync (no address on
  // the wire, so the slide being shown is the one the signal is for).
  const currentKeyRef = useRef<string | null>(null)
  useEffect(() => {
    const here = slideBoxes(document)[currentSlide]
    currentKeyRef.current = here ? fragmentKeyForBox(here) : null
  }, [document, currentSlide])
  // Listen for fragment state reports from iframes
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'tlda-fragment-state') {
        const { shapeId, current, total } = e.data
        const boxes = slideBoxes(document)
        const key = fragmentKeyForReport(e.data, boxes.some(b => b.indexh !== undefined))
        fragmentState.set(key, { total, current })
        const pending = pendingRemoteFragmentsRef.current.get(key)
        if (pending !== undefined && pending !== current) {
          if (reconcileFragment(shapeId, key, pending)) return
        }
        pendingRemoteFragmentsRef.current.delete(key)
        const here = boxes[currentSlide]
        if (here && key === fragmentKeyForBox(here)) {
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
      const key = currentKeyRef.current ?? signal.shapeId
      applyingRemoteFragmentRef.current = true
      pendingRemoteFragmentsRef.current.set(key, signal.current)
      const applied = reconcileFragment(signal.shapeId, key, signal.current)
      if (applied) {
        const fs = fragmentState.get(key)
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
    // An explicit ?slide link wins; otherwise resume this tab's last position
    // so a reload/remount continues the deck instead of resetting to 1.
    const positionKey = deckPositionKey(document.name)
    const initial = resolveInitialSlide(
      new URLSearchParams(window.location.search).get('slide'),
      readStoredSlide(positionKey),
      totalSlides,
    )
    setCurrentSlide(initial)
    storeSlide(positionKey, initial)
    navigateToSlide(editor, document, initial, false)
    window.document.body.classList.add('slides-mode')
    return () => {
      window.document.body.classList.remove('slides-mode')
      window.document.documentElement.style.removeProperty('--tlda-slide-background')
    }
  }, [editor, document, totalSlides])

  const goToSlide = useCallback((index: number, animate = true) => {
    const clamped = Math.max(0, Math.min(index, totalSlides - 1))
    setCurrentSlide(clamped)
    storeSlide(deckPositionKey(document.name), clamped)
    navigateToSlide(editor, document, clamped, animate)
    const page = slideBoxes(document)[clamped]
    setFragmentInfo(page ? fragmentState.get(fragmentKeyForBox(page)) ?? null : null)
    const shapeId = getDeckSyncShapeId(document)
    if (!applyingRemoteSlideRef.current && shapeId && getRole() === 'presenter') {
      broadcastSlideIndex(shapeId, clamped)
    }
  }, [editor, document, totalSlides])

  useEffect(() => {
    const activate = (event: MessageEvent) => {
      if (event.source !== window || event.data?.type !== 'tlda-slide-activate') return
      if (event.data.projectName && event.data.projectName !== document.name) return
      if (!Number.isInteger(event.data.index)) return
      goToSlide(event.data.index)
    }
    window.addEventListener('message', activate)
    return () => window.removeEventListener('message', activate)
  }, [document.name, goToSlide])

  useEffect(() => {
    return onSlideIndex((signal) => {
      if (getRole() !== 'viewer') return
      if (signal.shapeId !== getDeckSyncShapeId(document)) return
      applyingRemoteSlideRef.current = true
      goToSlide(signal.index)
      setTimeout(() => { applyingRemoteSlideRef.current = false }, 250)
    })
  }, [document, goToSlide])

  const handleNext = useCallback(() => {
    const box = slideBoxes(document)[currentSlide]
    if (!box) return
    // Fragments first, but only this slide's own: another slide's unstepped
    // fragments must never hold the camera back.
    const action = nextSlideAction(fragmentState, fragmentKeyForBox(box), currentSlide, totalSlides)
    if (action === 'step-fragment') {
      stepFragment(box.shapeId, 'next')
      return
    }
    // No more fragments — go to next slide
    if (action === 'advance-slide') {
      goToSlide(currentSlide + 1)
    }
  }, [currentSlide, totalSlides, document, goToSlide])

  const handlePrev = useCallback(() => {
    const box = slideBoxes(document)[currentSlide]
    if (!box) return
    // Try going back a fragment first — this slide's own only
    const action = prevSlideAction(fragmentState, fragmentKeyForBox(box), currentSlide)
    if (action === 'step-fragment') {
      stepFragment(box.shapeId, 'prev')
      return
    }
    // No more fragments back — go to prev slide
    if (action === 'retreat-slide') {
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
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        // A deck's address is 2D: horizontals across, verticals down under
        // their own column. Left/right walks the deck in reading order; up/down
        // moves within the column, which is the axis his 21-deep section needs.
        const boxes = slideBoxes(document)
        const here = boxes[currentSlide]
        if (!here || here.indexh === undefined) return
        e.preventDefault()
        const step = e.key === 'ArrowDown' ? 1 : -1
        const target = boxes.findIndex(
          b => b.indexh === here.indexh && b.indexv === (here.indexv ?? 0) + step,
        )
        if (target >= 0) goToSlide(target)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleNext, handlePrev, document, currentSlide, goToSlide])

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
        /* Skip: "just text plz--no background. and place lower so it's under
           the voicehud---we no bg it should fit". #voice-hud is fixed at
           bottom: 20px and is 19px tall, so 3px clears it with the counter in
           the strip underneath. Same offset at every width — the voice HUD it
           sits under has one too. */
        .slides-nav-counter {
          position: fixed;
          left: 50%;
          bottom: 3px;
          transform: translateX(-50%);
          display: flex;
          align-items: center;
          justify-content: center;
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
          color: #e0e0e0 !important;
        }
        @media (max-width: 900px), (pointer: coarse) {
          .slides-nav-button {
            width: 44px !important;
            height: 84px !important;
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
