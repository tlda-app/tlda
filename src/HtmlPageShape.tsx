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

  // Viewport gating: only render iframe when near viewport.
  // With multipage, each TLDraw page typically has one iframe, so this mainly
  // avoids rendering when zoomed very far out.
  const isNearViewport = useValue('near-viewport-' + shape.id, () => {
    const viewport = editor.getViewportPageBounds()
    const margin = viewport.height * 2
    const shapeTop = shape.y
    const shapeBottom = shape.y + shape.props.h
    return shapeBottom > viewport.minY - margin && shapeTop < viewport.maxY + margin
  }, [editor, shape.id, shape.y, shape.props.h])

  // Listen for height reports from iframe content
  // Read current height from the store (not the closure) to avoid stale delta calculations
  // when multiple postMessages arrive between React re-renders
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === 'ctd-wheel') {
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
      if (e.data?.type === 'ctd-navigate') {
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
              url.includes('/' + e.data.targetFile + '?')
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
            editor.centerOnPoint({ x: cx, y: targetShape.y + yOff }, { animation: { duration: 300 } })
          } else {
            // Anchor not resolved yet — center on page top, poll for anchor
            editor.centerOnPoint({ x: cx, y: targetShape.y + vpHeight * 0.3 }, { animation: { duration: 300 } })
            const poll = setInterval(() => {
              const yOff2 = htmlHeadingPositions.get(targetShape.id)?.[anchor!]
              if (yOff2 != null) {
                clearInterval(poll)
                const fresh = editor.store.get(targetShape.id) as any
                if (fresh) {
                  editor.centerOnPoint({ x: fresh.x + fresh.props.w / 2, y: fresh.y + yOff2 }, { animation: { duration: 300 } })
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
      if (e.data?.type === 'ctd-headings' && e.data.shapeId === shape.id) {
        htmlHeadingPositions.set(shape.id, e.data.positions)
        return
      }
      if (e.data?.type === 'ctd-figures' && e.data.shapeId === shape.id) {
        const current = editor.store.get(shape.id) as any
        if (!current) return
        const figures = e.data.figures as Array<{
          svgUrl: string; offsetY: number; w: number; h: number;
          id: string | null; caption: string | null; index: number;
        }>
        for (const fig of figures) {
          const figShapeId = createShapeId(`fig-${shape.id}-${fig.index}`)
          const existing = editor.store.get(figShapeId)
          if (!existing) {
            editor.createShapes([{
              id: figShapeId,
              type: 'svg-figure' as any,
              x: current.x,
              y: current.y + fig.offsetY,
              isLocked: true,
              props: {
                w: fig.w,
                h: fig.h,
                svgUrl: fig.svgUrl,
                parentShapeId: shape.id,
                offsetY: fig.offsetY,
                caption: fig.caption || undefined,
              },
            }])
          } else {
            // Update position if it shifted (MathJax, images loading)
            const newY = current.y + fig.offsetY
            if (Math.abs((existing as any).y - newY) > 3 ||
                Math.abs((existing as any).props.h - fig.h) > 3) {
              editor.store.update(figShapeId, (s: any) => ({
                ...s,
                y: newY,
                props: { ...s.props, w: fig.w, h: fig.h },
              }))
            }
          }
        }
        return
      }
      if (e.data?.type === 'ctd-resize' && e.data.shapeId === shape.id) {
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
    ? appendToken(shape.props.url + (shape.props.url.includes('?') ? '&' : '?') + `_ctdShape=${shape.id}`)
    : ''

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
                filter: isDark ? 'invert(0.88) hue-rotate(180deg)' : 'none',
                display: 'block',
              }}
              scrolling="no"
              allow="cross-origin-isolated"
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
        {/* Margin ribbons: always pointer-events:auto, outside the none wrapper */}
        {!iframeActive && (
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
