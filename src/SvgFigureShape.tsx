import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  useEditor,
  useValue,
  stopEventPropagation,
} from 'tldraw'
import { useEffect, useRef, useState, useCallback } from 'react'

// Module-level SVG content cache
const svgCache = new Map<string, string>()
// Module-level zoom/pan state (ephemeral, not persisted)
const viewState = new Map<string, { zoom: number; panX: number; panY: number }>()

export class SvgFigureShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'svg-figure' as const
  static override props = {
    w: T.number,
    h: T.number,
    svgUrl: T.string,
    parentShapeId: T.string,
    offsetY: T.number,
    caption: T.optional(T.string),
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

  // Fetch SVG content
  useEffect(() => {
    if (!shape.props.svgUrl) return
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
  }, [shape.props.svgUrl])

  // Inject SVG into DOM
  useEffect(() => {
    if (!innerRef.current || !svgContent) return
    innerRef.current.innerHTML = svgContent
    // Make the embedded SVG fill the container
    const svg = innerRef.current.querySelector('svg')
    if (svg) {
      svg.style.width = '100%'
      svg.style.height = '100%'
      svg.removeAttribute('width')
      svg.removeAttribute('height')
    }
  }, [svgContent])

  // Get current view state
  const getView = useCallback(() => {
    return viewState.get(shape.id) || { zoom: 1, panX: 0, panY: 0 }
  }, [shape.id])

  // Update view state and re-render
  const setView = useCallback((zoom: number, panX: number, panY: number) => {
    viewState.set(shape.id, { zoom, panX, panY })
    forceRender(n => n + 1)
  }, [shape.id])

  // Wheel handler for zoom/pan
  useEffect(() => {
    const el = containerRef.current
    if (!el || isPenMode) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const view = getView()
      if (e.ctrlKey || e.metaKey) {
        // Zoom
        const factor = e.deltaY > 0 ? 0.9 : 1.1
        const newZoom = Math.max(0.5, Math.min(5, view.zoom * factor))
        setView(newZoom, view.panX, view.panY)
      } else {
        // Pan
        const dx = e.deltaX / view.zoom
        const dy = e.deltaY / view.zoom
        setView(view.zoom, view.panX - dx, view.panY - dy)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [isPenMode, getView, setView])

  // Double-tap to reset zoom
  const lastTapRef = useRef(0)
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (isPenMode) return
    stopEventPropagation(e)
    const now = Date.now()
    if (now - lastTapRef.current < 300) {
      // Double-tap: reset
      setView(1, 0, 0)
    }
    lastTapRef.current = now
  }, [isPenMode, setView])

  const view = getView()
  const pointerEvents = isPenMode ? 'none' : 'all'

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
