import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  useEditor,
  useValue,
  stopEventPropagation,
} from 'tldraw'
import { useEffect, useRef, useState, useCallback } from 'react'
import { htmlIframeElements } from './HtmlPageShape'

// Module-level SVG content cache
const svgCache = new Map<string, string>()
// Module-level zoom/pan state (ephemeral, not persisted)
const viewState = new Map<string, { zoom: number; panX: number; panY: number }>()
// Coupled zoom groups
const cameraGroups = new Map<string, Set<string>>()
const groupListeners = new Map<string, () => void>()
const groupTransformSenders = new Map<string, (zoom: number, panX: number, panY: number) => void>()

export class SvgFigureShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'svg-figure' as const
  static override props = {
    w: T.number,
    h: T.number,
    svgUrl: T.string,
    parentShapeId: T.string,
    offsetY: T.number,
    caption: T.optional(T.string),
    group: T.optional(T.string),
    figureIdx: T.optional(T.number),
  }

  getDefaultProps() {
    return { w: 672, h: 400, svgUrl: '', parentShapeId: '', offsetY: 0 }
  }

  override canEdit = () => false
  override canResize = () => false
  override isAspectRatioLocked = () => true
  override hideRotateHandle = () => true
  override canBind = () => false

  component(shape: any) {
    return <SvgFigureComponent shape={shape} />
  }

  backgroundComponent(shape: any) {
    return <SvgFigureBackground shape={shape} />
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} rx={2} ry={2} />
  }
}

function SvgFigureBackground({ shape }: { shape: any }) {
  return null
}

function SvgFigureComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const isDark = useValue('isDarkMode', () => editor.user.getIsDarkMode(), [editor])
  const isPenMode = useValue('pen-mode', () => editor.getInstanceState().isPenMode, [editor])
  const containerRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const [svgContent, setSvgContent] = useState<string | null>(null)
  const [, forceRender] = useState(0)
  const [isActive, setIsActive] = useState(false)

  const isInline = shape.props.figureIdx != null

  // Click outside or wheel outside deactivates zoom mode
  useEffect(() => {
    if (!isActive) return
    let pointerHandler: (() => void) | null = null
    let wheelHandler: (() => void) | null = null
    const timer = setTimeout(() => {
      pointerHandler = () => setIsActive(false)
      wheelHandler = () => setIsActive(false)
      window.addEventListener('pointerdown', pointerHandler, { once: true })
      window.addEventListener('wheel', wheelHandler, { once: true })
    }, 50)
    return () => {
      clearTimeout(timer)
      if (pointerHandler) window.removeEventListener('pointerdown', pointerHandler)
      if (wheelHandler) window.removeEventListener('wheel', wheelHandler)
    }
  }, [isActive])

  // Fetch SVG content (only for non-inline figures)
  useEffect(() => {
    if (isInline || !shape.props.svgUrl) return
    const cached = svgCache.get(shape.props.svgUrl)
    if (cached) {
      setSvgContent(cached)
      return
    }
    fetch(shape.props.svgUrl)
      .then(r => r.ok ? r.text() : null)
      .then(text => {
        if (text) {
          svgCache.set(shape.props.svgUrl, text)
          setSvgContent(text)
        }
      })
      .catch(() => {})
  }, [shape.props.svgUrl, isInline])

  // Inject SVG into DOM (only for non-inline figures)
  useEffect(() => {
    if (isInline || !innerRef.current || !svgContent) return
    innerRef.current.innerHTML = svgContent
    const svg = innerRef.current.querySelector('svg')
    if (svg) {
      svg.style.width = '100%'
      svg.style.height = '100%'
      svg.removeAttribute('width')
      svg.removeAttribute('height')
    }
  }, [svgContent, isInline])

  // Get current view state
  const getView = useCallback(() => {
    return viewState.get(shape.id) || { zoom: 1, panX: 0, panY: 0 }
  }, [shape.id])

  // Register in coupled zoom group
  const group = shape.props.group as string | undefined
  useEffect(() => {
    if (!group) return
    let set = cameraGroups.get(group)
    if (!set) { set = new Set(); cameraGroups.set(group, set) }
    set.add(shape.id)
    groupListeners.set(shape.id, () => forceRender(n => n + 1))
    return () => {
      set!.delete(shape.id)
      if (set!.size === 0) cameraGroups.delete(group)
      groupListeners.delete(shape.id)
    }
  }, [group, shape.id])

  // Send transform to iframe for inline figures
  const sendTransform = useCallback((zoom: number, panX: number, panY: number) => {
    if (!isInline) return
    const iframe = htmlIframeElements.get(shape.props.parentShapeId)
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage({
        type: 'tlda-figure-transform',
        figureIdx: String(shape.props.figureIdx),
        zoom, panX, panY,
      }, '*')
    }
  }, [isInline, shape.props.parentShapeId, shape.props.figureIdx])

  // Register transform sender for coupled zoom peers
  useEffect(() => {
    groupTransformSenders.set(shape.id, sendTransform)
    return () => { groupTransformSenders.delete(shape.id) }
  }, [shape.id, sendTransform])

  // Update view state and re-render; broadcast to coupled peers
  const setView = useCallback((zoom: number, panX: number, panY: number, broadcast = true) => {
    viewState.set(shape.id, { zoom, panX, panY })
    forceRender(n => n + 1)
    sendTransform(zoom, panX, panY)
    if (broadcast && group) {
      const peers = cameraGroups.get(group)
      if (peers) {
        for (const peerId of peers) {
          if (peerId !== shape.id) {
            viewState.set(peerId, { zoom, panX, panY })
            groupTransformSenders.get(peerId)?.(zoom, panX, panY)
            groupListeners.get(peerId)?.()
          }
        }
      }
    }
  }, [shape.id, group, sendTransform])

  // Wheel handler for zoom/pan — only when activated by click
  useEffect(() => {
    const el = containerRef.current
    if (!el || isPenMode || !isActive) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const view = getView()
      if (e.ctrlKey || e.metaKey) {
        const factor = e.deltaY > 0 ? 0.9 : 1.1
        const newZoom = Math.max(0.5, Math.min(5, view.zoom * factor))
        setView(newZoom, view.panX, view.panY)
      } else {
        const dx = e.deltaX / view.zoom
        const dy = e.deltaY / view.zoom
        setView(view.zoom, view.panX - dx, view.panY - dy)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [isPenMode, isActive, getView, setView])

  // Click to activate zoom mode; double-tap to reset zoom
  const lastTapRef = useRef(0)
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (isPenMode) return
    stopEventPropagation(e)
    const now = Date.now()
    if (now - lastTapRef.current < 300) {
      setView(1, 0, 0)
    } else {
      setIsActive(true)
    }
    lastTapRef.current = now
  }, [isPenMode, setView])

  const view = getView()
  // When inactive, only intercept pointer (for click-to-activate) not wheel
  const pointerEvents = isPenMode ? 'none' : 'all'

  // Inline figures: transparent overlay, content stays in iframe
  const isZoomed = view.zoom !== 1 || view.panX !== 0 || view.panY !== 0
  const handleReset = useCallback((e: React.PointerEvent) => {
    stopEventPropagation(e)
    setView(1, 0, 0)
  }, [setView])

  if (isInline) {
    return (
      <HTMLContainer>
        <div
          ref={containerRef}
          style={{
            width: shape.props.w,
            height: shape.props.h,
            pointerEvents,
          }}
          onPointerDown={onPointerDown}
          onPointerUp={isPenMode ? undefined : stopEventPropagation}
        >
          {isZoomed && (
            <span
              className="figure-zoom-reset"
              onPointerDown={handleReset}
              style={{ position: 'absolute', top: -16, right: 0 }}
              title="Reset zoom"
            >&#8634;</span>
          )}
        </div>
      </HTMLContainer>
    )
  }

  // Non-inline figures: fetch and render SVG content
  return (
    <HTMLContainer>
      <div
        ref={containerRef}
        style={{
          width: shape.props.w,
          height: shape.props.h,
          overflow: 'hidden',
          pointerEvents,
        }}
        onPointerDown={onPointerDown}
        onPointerUp={isPenMode ? undefined : stopEventPropagation}
      >
        {svgContent ? (
          <div
            ref={innerRef}
            style={{
              width: shape.props.w,
              height: shape.props.h,
              transform: `scale(${view.zoom}) translate(${view.panX}px, ${view.panY}px)`,
              transformOrigin: '0 0',
              filter: isDark ? 'invert(0.88) hue-rotate(180deg)' : 'none',
            }}
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
            Loading figure...
          </div>
        )}
      </div>
    </HTMLContainer>
  )
}
