import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  Vec,
  createShapeId,
  useEditor,
  useValue,
  stopEventPropagation,
} from 'tldraw'
import type { TLPageId } from 'tldraw'
import { useEffect, useRef, useState, useCallback } from 'react'
import { appendToken } from './authToken'

// Heading Y positions reported by bridge scripts, keyed by shape ID
export const htmlHeadingPositions = new Map<string, Record<string, number>>()

/** Get the Y offset of a heading anchor within an HTML page shape, or undefined if not found. */
export function getHtmlHeadingY(shapeId: string, anchor: string): number | undefined {
  return htmlHeadingPositions.get(shapeId)?.[anchor]
}

// Iframe element refs, keyed by shape ID (for SvgFigureShape to send transform messages)
export const htmlIframeElements = new Map<string, HTMLIFrameElement>()

// Scrollytelling region metadata reported by bridge scripts, keyed by shape ID
export interface ScrollyStep {
  y: number           // document offset (px from top of iframe content)
  label: string       // step label from data-labels
  imageUrl: string    // absolute URL to the step's SVG image
  text: string        // step narrative text content
}

export interface ScrollyRegion {
  id: string          // container ID or generated
  startY: number      // top of the image-toggle container
  endY: number        // bottom of the last step element
  steps: ScrollyStep[]
}

export const htmlScrollyRegions = new Map<string, ScrollyRegion[]>()


export class HtmlPageShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'html-page' as const
  static override props = {
    w: T.number,
    h: T.number,
    url: T.string,
  }

  getDefaultProps() {
    return { w: 800, h: 1000, url: '' }
  }

  override canEdit = () => false
  override canResize = () => false
  override isAspectRatioLocked = () => true
  override hideRotateHandle = () => true
  override canBind = () => false

  component(shape: any) {
    return <HtmlPageComponent shape={shape} />
  }

  backgroundComponent(shape: any) {
    return <HtmlPageBackground shape={shape} />
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} rx={2} ry={2} />
  }
}

function HtmlPageBackground({ shape }: { shape: any }) {
  return null
}

function HtmlPageComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const isDark = useValue('isDarkMode', () => editor.user.getIsDarkMode(), [editor])
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // Register iframe ref for SvgFigureShape to send transform messages
  useEffect(() => {
    return () => { htmlIframeElements.delete(shape.id) }
  }, [shape.id])

  // Iframes are pointer-events:none by default so TLDraw tools work normally.
  // Two ways to enable iframe interaction:
  // 1. Text-select tool ('t' key) — global, all iframes become interactive
  // 2. Click the margin ribbon — local, just this iframe becomes interactive
  const isTextSelectTool = useValue('text-select-tool', () =>
    editor.getCurrentToolId() === 'text-select', [editor])
  const isBrowseTool = useValue('browse-tool', () =>
    editor.getCurrentToolId() === 'browse', [editor])
  const [isInteracting, setIsInteracting] = useState(false)
  const iframeActive = isTextSelectTool || isInteracting || isBrowseTool

  // Detect slides format from URL (has _tldaH param)
  const isSlide = shape.props.url?.includes('_tldaH=')

  // Viewport gating: only render iframe when near viewport.
  // With multipage, each TLDraw page typically has one iframe, so this mainly
  // avoids rendering when zoomed very far out.
  const isNearViewport = useValue('near-viewport-' + shape.id, () => {
    const viewport = editor.getViewportPageBounds()
    // Slides use a larger keep-alive margin so scrolling back doesn't trigger a full reload.
    // SVG pages use 2x height since each page is on its own TLDraw page anyway.
    const margin = viewport.height * (isSlide ? 6 : 2)
    const shapeTop = shape.y
    const shapeBottom = shape.y + shape.props.h
    return shapeBottom > viewport.minY - margin && shapeTop < viewport.maxY + margin
  }, [editor, shape.id, shape.y, shape.props.h, isSlide])

  // Slide fade-in: start invisible, show when Reveal signals ready.
  // Reset when isNearViewport goes false (iframe unmounted).
  const [slideReady, setSlideReady] = useState(false)
  useEffect(() => {
    if (!isNearViewport) setSlideReady(false)
  }, [isNearViewport])

  // When entering local interaction mode, listen for clicks or wheel outside to exit
  useEffect(() => {
    if (!isInteracting) return
    let pointerHandler: (() => void) | null = null
    let wheelHandler: (() => void) | null = null
    const timer = setTimeout(() => {
      pointerHandler = () => setIsInteracting(false)
      wheelHandler = () => setIsInteracting(false)
      window.addEventListener('pointerdown', pointerHandler, { once: true })
      window.addEventListener('wheel', wheelHandler, { once: true })
    }, 50)
    return () => {
      clearTimeout(timer)
      if (pointerHandler) window.removeEventListener('pointerdown', pointerHandler)
      if (wheelHandler) window.removeEventListener('wheel', wheelHandler)
    }
  }, [isInteracting])

  const handleRibbonPointerDown = useCallback((e: React.PointerEvent) => {
    stopEventPropagation(e)
    setIsInteracting(true)
  }, [])

  // Send dark mode state to iframe content (semantic dark mode, no CSS invert)
  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe?.contentWindow) return
    iframe.contentWindow.postMessage({ type: 'tlda-dark-mode', dark: isDark }, '*')
  }, [isDark])

  // Also send on iframe load
  const handleIframeLoad = useCallback(() => {
    const iframe = iframeRef.current
    if (!iframe?.contentWindow) return
    htmlIframeElements.set(shape.id, iframe)
    iframe.contentWindow.postMessage({ type: 'tlda-dark-mode', dark: isDark }, '*')
    // Mark ready on load. For slides, Reveal.js navigates to the target slide during
    // initialization, so by the time onLoad fires the slide is already at the right position.
    setSlideReady(true)
  }, [isDark, isSlide])

  // Listen for height reports from iframe content
  // Read current height from the store (not the closure) to avoid stale delta calculations
  // when multiple postMessages arrive between React re-renders
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'tlda-wheel') {
        // Forward wheel events from iframe bridge directly to TLDraw's editor.dispatch
        // (synthetic DOM WheelEvents don't reach @use-gesture's internal handler)
        const { deltaX, deltaY, ctrlKey, metaKey } = e.data
        // Negate deltas: browser wheel deltaY>0 = scroll down, but TLDraw's
        // internal convention (from @use-gesture) uses negative = pan down.
        editor.dispatch({
          type: 'wheel',
          name: 'wheel',
          delta: new Vec(-deltaX, -deltaY, 0),
          point: new Vec(editor.inputs.currentScreenPoint.x, editor.inputs.currentScreenPoint.y),
          shiftKey: false,
          altKey: false,
          ctrlKey: !!ctrlKey,
          metaKey: !!metaKey,
          accelKey: !!(ctrlKey || metaKey),
        })
        return
      }
      if (e.data?.type === 'tlda-navigate') {
        // Route navigation from iframe links to page switch + anchor scroll.
        // Search ALL pages for the target shape (cross-chapter navigation).
        const allHtmlShapes = Object.values(editor.store.allRecords())
          .filter((r: any) => r.typeName === 'shape' && r.type === 'html-page') as any[]
        let targetShape: any = null
        const anchor = e.data.anchor || null
        if (e.data.targetFile) {
          targetShape = allHtmlShapes.find((s: any) => {
            const url = s.props.url || ''
            return url.endsWith('/' + e.data.targetFile) ||
              url.includes('/' + e.data.targetFile + '?') ||
              url.includes('/' + e.data.targetFile + '/')
          })
        } else {
          targetShape = allHtmlShapes.find((s: any) => s.id === e.data.shapeId)
        }
        // Fall back to searching heading positions if anchor not in target
        if (targetShape && anchor) {
          const positions = htmlHeadingPositions.get(targetShape.id)
          if (!positions?.[anchor]) {
            const altShape = allHtmlShapes.find((s: any) => {
              const pos = htmlHeadingPositions.get(s.id)
              return pos?.[anchor] != null
            })
            if (altShape) targetShape = altShape
          }
        }
        if (!targetShape) return

        // Switch to the target shape's TLDraw page
        const targetPageId = targetShape.parentId as TLPageId
        if (targetPageId !== editor.getCurrentPageId()) {
          editor.setCurrentPage(targetPageId)
        }

        // Center on anchor or page top
        const vpHeight = editor.getViewportPageBounds().h
        const cx = targetShape.x + targetShape.props.w / 2
        if (anchor) {
          const yOff = htmlHeadingPositions.get(targetShape.id)?.[anchor]
          if (yOff != null) {
            // Place heading at ~15% from top (center + 0.35*vh pushes heading up from center)
            editor.centerOnPoint({ x: cx, y: targetShape.y + yOff + vpHeight * 0.35 }, { animation: { duration: 300 } })
          } else {
            // Anchor not resolved yet — center on page top, poll for anchor
            editor.centerOnPoint({ x: cx, y: targetShape.y + vpHeight * 0.3 }, { animation: { duration: 300 } })
            const poll = setInterval(() => {
              const yOff2 = htmlHeadingPositions.get(targetShape.id)?.[anchor!]
              if (yOff2 != null) {
                clearInterval(poll)
                const fresh = editor.store.get(targetShape.id) as any
                if (fresh) {
                  const vph = editor.getViewportPageBounds().h
                  editor.centerOnPoint({ x: fresh.x + fresh.props.w / 2, y: fresh.y + yOff2 + vph * 0.35 }, { animation: { duration: 300 } })
                }
              }
            }, 200)
            setTimeout(() => clearInterval(poll), 8000)
          }
        } else {
          editor.centerOnPoint({ x: cx, y: targetShape.y + vpHeight * 0.3 }, { animation: { duration: 300 } })
        }
        return
      }
      if (e.data?.type === 'tlda-navigate-rel') {
        // Prev/next chapter navigation from footer links
        const pages = editor.getPages()
        const currentPageId = editor.getCurrentPageId()
        const currentIdx = pages.findIndex(p => p.id === currentPageId)
        const targetIdx = e.data.direction === 'next' ? currentIdx + 1 : currentIdx - 1
        if (targetIdx >= 0 && targetIdx < pages.length) {
          editor.setCurrentPage(pages[targetIdx].id)
          // Center on top of the new page's html-page shape
          setTimeout(() => {
            const shapes = editor.getCurrentPageShapes()
            const htmlShape = shapes.find((s: any) => s.type === 'html-page') as any
            if (htmlShape) {
              const vpHeight = editor.getViewportPageBounds().h
              editor.centerOnPoint(
                { x: htmlShape.x + htmlShape.props.w / 2, y: htmlShape.y + vpHeight * 0.3 },
                { animation: { duration: 300 } }
              )
            }
          }, 100)
        }
        return
      }
      if (e.data?.type === 'tlda-headings' && e.data.shapeId === shape.id) {
        htmlHeadingPositions.set(shape.id, e.data.positions)
        return
      }
      if (e.data?.type === 'tlda-scrolly-regions' && e.data.shapeId === shape.id) {
        htmlScrollyRegions.set(shape.id, e.data.regions)
        return
      }
      if (e.data?.type === 'tlda-figures' && e.data.shapeId === shape.id) {
        // Defer figure shape creation so it doesn't block initial render
        requestAnimationFrame(() => {
          const current = editor.store.get(shape.id) as any
          if (!current) return
          const figures = e.data.figures as Array<{
            svgUrl: string; inline?: boolean; offsetX?: number; offsetY: number; w: number; h: number;
            id: string | null; caption: string | null; index: number;
            group?: string | null;
          }>
          // Batch: collect all new shapes, create in one call
          const toCreate: any[] = []
          for (const fig of figures) {
            const figShapeId = createShapeId(`fig-${shape.id}-${fig.index}`)
            const existing = editor.store.get(figShapeId)
            if (!existing) {
              toCreate.push({
                id: figShapeId,
                type: 'svg-figure' as any,
                x: current.x + (fig.offsetX || 0),
                y: current.y + fig.offsetY,
                isLocked: true,
                props: {
                  w: fig.w,
                  h: fig.h,
                  svgUrl: fig.svgUrl,
                  parentShapeId: shape.id,
                  offsetY: fig.offsetY,
                  caption: fig.caption || undefined,
                  group: fig.group || undefined,
                  figureIdx: fig.inline ? fig.index : undefined,
                },
              })
            } else {
              const newX = current.x + (fig.offsetX || 0)
              const newY = current.y + fig.offsetY
              if (Math.abs((existing as any).x - newX) > 3 ||
                  Math.abs((existing as any).y - newY) > 3 ||
                  Math.abs((existing as any).props.h - fig.h) > 3) {
                editor.store.update(figShapeId, (s: any) => ({
                  ...s,
                  x: newX,
                  y: newY,
                  props: { ...s.props, w: fig.w, h: fig.h },
                }))
              }
            }
          }
          if (toCreate.length > 0) {
            editor.createShapes(toCreate)
          }
        })
        return
      }
      if (e.data?.type === 'tlda-slide-ready' && e.data.shapeId === shape.id) {
        setSlideReady(true)
        return
      }
      if (e.data?.type === 'tlda-resize' && e.data.shapeId === shape.id) {
        const newH = Math.max(200, Math.round(e.data.height))
        const current = editor.store.get(shape.id) as any
        if (!current) return
        if (Math.abs(newH - current.props.h) > 5) {
          editor.store.update(shape.id, (s: any) => ({
            ...s,
            props: { ...s.props, h: newH },
          }))
        }
      }
    }
    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [shape.id, editor])

  // Pass shape ID and auth token to iframe
  const urlWithParams = shape.props.url
    ? appendToken(shape.props.url + (shape.props.url.includes('?') ? '&' : '?') + `_tldaShape=${shape.id}`)
    : ''

  const handleFragmentStep = useCallback((direction: 'next' | 'prev') => {
    const iframe = iframeRef.current
    if (!iframe?.contentWindow) return
    iframe.contentWindow.postMessage({
      type: direction === 'next' ? 'tlda-fragment-next' : 'tlda-fragment-prev',
    }, '*')
  }, [])

  const ribbonStyle: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 10,
    pointerEvents: 'auto',
    cursor: 'text',
    opacity: 0,
    transition: 'opacity 0.15s',
    background: isDark ? 'rgba(139,92,246,0.25)' : 'rgba(139,92,246,0.15)',
    zIndex: 2,
  }

  return (
    <HTMLContainer>
      <div style={{
        width: shape.props.w,
        height: shape.props.h,
        position: 'relative',
        pointerEvents: iframeActive ? 'auto' : 'none',
      }}>
        {/* Content layer: pointer-events controlled by interaction state */}
        <div style={{
          width: '100%',
          height: '100%',
          overflow: 'hidden',
          pointerEvents: iframeActive ? 'auto' : 'none',
        }}>
          {isNearViewport && urlWithParams ? (
            <iframe
              ref={iframeRef}
              src={urlWithParams}
              style={{
                width: '100%',
                height: '100%',
                border: 'none',
                pointerEvents: iframeActive ? 'auto' : 'none',
                display: 'block',
                opacity: isSlide ? (slideReady ? 1 : 0) : 1,
                transition: isSlide ? 'opacity 0.25s ease' : undefined,
              }}
              scrolling="no"
              allow="cross-origin-isolated"
              onLoad={handleIframeLoad}
            />
          ) : (
            <div style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)',
              fontSize: '14px',
              fontFamily: '-apple-system, sans-serif',
            }}>
              {urlWithParams ? 'Loading...' : ''}
            </div>
          )}
        </div>
        {/* Slides: full-size overlay captures wheel events in parent context,
            avoiding the Safari postMessage round-trip for scroll gestures */}
        {isSlide && !iframeActive && (
          <div style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'auto',
            zIndex: 1,
          }} />
        )}
        {/* Slides: edge tap zones for fragment stepping (work from any tool) */}
        {isSlide && !iframeActive && (
          <>
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: 44,
                height: '100%',
                pointerEvents: 'auto',
                cursor: 'pointer',
                zIndex: 2,
              }}
              onPointerDown={(e) => { stopEventPropagation(e); handleFragmentStep('prev') }}
            />
            <div
              style={{
                position: 'absolute',
                top: 0,
                right: 0,
                width: 44,
                height: '100%',
                pointerEvents: 'auto',
                cursor: 'pointer',
                zIndex: 2,
              }}
              onPointerDown={(e) => { stopEventPropagation(e); handleFragmentStep('next') }}
            />
          </>
        )}
        {/* Margin ribbons: always pointer-events:auto, outside the none wrapper (non-slides) */}
        {!isSlide && !iframeActive && (
          <>
            <div
              className="iframe-ribbon"
              style={{ ...ribbonStyle, left: 0 }}
              onPointerDown={handleRibbonPointerDown}
            />
            <div
              className="iframe-ribbon"
              style={{ ...ribbonStyle, right: 0 }}
              onPointerDown={handleRibbonPointerDown}
            />
          </>
        )}
      </div>
    </HTMLContainer>
  )
}
