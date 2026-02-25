import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  Vec,
  useEditor,
  useValue,
  createShapeId,
  stopEventPropagation,
  atom,
} from 'tldraw'
import { useEffect, useRef, useState, useCallback } from 'react'
import { appendToken } from './authToken'
import { PAGE_GAP } from './layoutConstants'

// Number of page-heights beyond viewport to keep iframe alive
const VIEWPORT_BUFFER_PAGES = 2

// Heading Y positions reported by bridge scripts, keyed by shape ID
export const htmlHeadingPositions = new Map<string, Record<string, number>>()

// Shape IDs that should pre-load their iframe ahead of the camera arriving.
// Reactive atom so useValue re-evaluates when the set changes.
const preloadShapeIds = atom<ReadonlySet<string>>('preload-shapes', new Set())

// Active navigation tracker — cancel previous before starting new one
let activeNavTracker: ReturnType<typeof setInterval> | null = null
let activeNavTimeout: ReturnType<typeof setTimeout> | null = null

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

  // Viewport gating: only render iframe when near viewport
  // Use viewport height (not shape height) for the buffer so tall chapters don't
  // keep distant iframes alive indefinitely.
  // Also render if this shape is in the preload set (cross-chapter nav target).
  const isNearViewport = useValue('near-viewport-' + shape.id, () => {
    if (preloadShapeIds.get().has(shape.id)) return true
    const viewport = editor.getViewportPageBounds()
    const margin = viewport.height * VIEWPORT_BUFFER_PAGES
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
        // Route navigation from iframe links to canvas scroll
        const allShapes = editor.getCurrentPageShapes()
          .filter((s: any) => s.type === 'html-page')
          .sort((a: any, b: any) => a.y - b.y)
        let targetShape: any = null
        const anchor = e.data.anchor || null
        if (e.data.targetFile) {
          targetShape = allShapes.find((s: any) => {
            const url = s.props.url || ''
            return url.endsWith('/' + e.data.targetFile) ||
              url.includes('/' + e.data.targetFile + '?')
          })
        } else {
          targetShape = allShapes.find((s: any) => s.id === e.data.shapeId)
        }
        // Quarto cross-chapter refs use same-host full URLs, so targetFile is null
        // but the anchor may be in a different chapter. Fall back to searching all
        // shapes' heading positions when the anchor isn't in the sending shape.
        if (targetShape && anchor) {
          const positions = htmlHeadingPositions.get(targetShape.id)
          if (!positions?.[anchor]) {
            const altShape = allShapes.find((s: any) => {
              const pos = htmlHeadingPositions.get(s.id)
              return pos?.[anchor] != null
            })
            if (altShape) targetShape = altShape
          }
        }
        if (!targetShape) return
        const targetId = targetShape.id

        // Cancel any previous navigation tracker before starting a new one.
        // Multiple component instances receive the same message — only one
        // should own the tracker. Use the module-level variables as a lock.
        if (activeNavTracker) { clearInterval(activeNavTracker); activeNavTracker = null }
        if (activeNavTimeout) { clearTimeout(activeNavTimeout); activeNavTimeout = null }
        // Clear any stale preload flags from previous navigation
        if (preloadShapeIds.get().size > 0) {
          preloadShapeIds.set(new Set())
        }

        // Pre-load: start the target iframe loading before the camera arrives.
        preloadShapeIds.set(new Set([targetId]))

        // Helper: compute the target Y, re-reading shape from store for fresh position.
        // centerOnPoint puts the target at viewport center, so offset when scrolling
        // to a page top — place the top of the chapter near the top of the viewport.
        const vpHeight = editor.getViewportPageBounds().h
        const getTargetY = () => {
          const fresh = editor.store.get(targetId) as any
          if (!fresh) return null
          const cx = fresh.x + fresh.props.w / 2
          if (anchor) {
            const positions = htmlHeadingPositions.get(targetId)
            const yOff = positions?.[anchor]
            return { x: cx, y: yOff != null ? fresh.y + yOff : fresh.y + vpHeight * 0.3 }
          }
          return { x: cx, y: fresh.y + vpHeight * 0.3 }
        }

        const pt = getTargetY()
        if (pt) editor.centerOnPoint(pt, { animation: { duration: 300 } })

        // Track the target shape as reflow shifts its position.
        // Intermediate iframes loading and reporting heights push shapes down
        // continuously over the first few seconds. Poll every 500ms and re-center
        // when the target drifts, then clean up the preload flag when stable.
        let lastY = pt?.y ?? 0
        let stableCount = 0
        activeNavTracker = setInterval(() => {
          const pt2 = getTargetY()
          if (!pt2) { clearInterval(activeNavTracker!); activeNavTracker = null; return }
          if (Math.abs(pt2.y - lastY) > 20) {
            lastY = pt2.y
            stableCount = 0
            editor.centerOnPoint(pt2, { animation: { duration: 200 } })
          } else {
            stableCount++
          }
          // After 3 stable checks (1.5s of no movement), we're settled
          if (stableCount >= 3) {
            clearInterval(activeNavTracker!); activeNavTracker = null
            // Clear preload flag — viewport gating handles it from here
            if (preloadShapeIds.get().has(targetId)) {
              const next = new Set(preloadShapeIds.get())
              next.delete(targetId)
              preloadShapeIds.set(next)
            }
          }
        }, 500)
        // Safety: clear after 10s no matter what
        activeNavTimeout = setTimeout(() => {
          if (activeNavTracker) { clearInterval(activeNavTracker); activeNavTracker = null }
          if (preloadShapeIds.get().has(targetId)) {
            const next = new Set(preloadShapeIds.get())
            next.delete(targetId)
            preloadShapeIds.set(next)
          }
        }, 10000)
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
        const oldH = current.props.h
        if (Math.abs(newH - oldH) > 5) {
          const delta = newH - oldH
          // Update this shape's height
          editor.store.update(shape.id, (s: any) => ({
            ...s,
            props: { ...s.props, h: newH },
          }))
          // Reflow: push all html-page shapes below this one down by the delta
          const allShapes = editor.getCurrentPageShapes()
          const allPages = allShapes
            .filter((s: any) => s.type === 'html-page' && s.y > current.y)
          for (const below of allPages) {
            editor.store.update(below.id, (s: any) => ({
              ...s,
              y: s.y + delta,
            }))
          }
          // Also move svg-figure shapes belonging to any page that moved
          const movedPageIds = new Set([...allPages.map((s: any) => s.id)])
          const childFigures = allShapes
            .filter((s: any) => s.type === 'svg-figure' && movedPageIds.has(s.props.parentShapeId))
          for (const fig of childFigures) {
            editor.store.update(fig.id, (s: any) => ({
              ...s,
              y: s.y + delta,
            }))
          }
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
