/**
 * ZoomableImageShape — chromeless image viewer with independent pan/zoom.
 * Replaces a static image shape at the same position so the user can
 * pinch-zoom into the image without moving the outer canvas.
 *
 * Uses CSS transforms directly (no nested Tldraw) for reliable event
 * isolation — outer canvas wheel/pinch events don't conflict.
 *
 * Props:
 *   - w/h: outer shape dimensions on the main canvas
 *   - src: image data URL or HTTP URL
 *   - imageW/imageH: natural image dimensions
 *   - cameraGroup: optional group name — images with same group share zoom/pan
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  stopEventPropagation,
} from 'tldraw'
import { getCameraGroup, setCameraGroup, subscribeCameraGroup, type CameraState } from './cameraGroups'

export class ZoomableImageShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'zoomable-image' as const
  static override props = {
    w: T.number,
    h: T.number,
    src: T.string,
    imageW: T.number,
    imageH: T.number,
    cameraGroup: T.optional(T.string),
  }

  getDefaultProps() {
    return { w: 800, h: 600, src: '', imageW: 800, imageH: 600, cameraGroup: undefined }
  }

  override canEdit = () => false
  override canResize = () => false
  override canBind = () => false
  override isAspectRatioLocked = () => true
  override hideRotateHandle = () => true
  override hideResizeHandles = () => true
  override hideSelectionBoundsBg = () => true
  override hideSelectionBoundsFg = () => true

  component(shape: any) {
    return <ZoomableImageComponent shape={shape} />
  }

  backgroundComponent(_shape: any) {
    return <div style={{ width: '100%', height: '100%', backgroundColor: 'white' }} />
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} />
  }
}

const MIN_ZOOM = 1
const MAX_ZOOM = 10

function ZoomableImageComponent({ shape }: { shape: any }) {
  const { w, h, src, cameraGroup } = shape.props
  const containerRef = useRef<HTMLDivElement>(null)

  // Camera state: zoom level and offset (in image-space pixels)
  // If grouped, initialize from shared state
  const cameraRef = useRef<CameraState>(
    cameraGroup ? { ...getCameraGroup(cameraGroup) } : { zoom: 1, x: 0, y: 0 }
  )
  const [, forceRender] = useState(0)
  // Track whether this component initiated the current change (prevent echo)
  const isLocalChange = useRef(false)

  // Subscribe to group camera changes from other images
  useEffect(() => {
    if (!cameraGroup) return
    return subscribeCameraGroup(cameraGroup, (state) => {
      if (isLocalChange.current) return
      cameraRef.current = { ...state }
      forceRender((n) => n + 1)
    })
  }, [cameraGroup])

  const clampCamera = useCallback(
    (cam: CameraState) => {
      cam.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cam.zoom))
      // Clamp pan so the image doesn't move outside the viewport
      const maxX = Math.max(0, (w * cam.zoom - w) / (2 * cam.zoom))
      const maxY = Math.max(0, (h * cam.zoom - h) / (2 * cam.zoom))
      cam.x = Math.max(-maxX, Math.min(maxX, cam.x))
      cam.y = Math.max(-maxY, Math.min(maxY, cam.y))
      return cam
    },
    [w, h],
  )

  // Broadcast camera change to group
  const broadcastCamera = useCallback(
    (cam: CameraState) => {
      if (!cameraGroup) return
      isLocalChange.current = true
      setCameraGroup(cameraGroup, { ...cam })
      isLocalChange.current = false
    },
    [cameraGroup],
  )

  // Wheel → zoom, centered on cursor
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()

      const cam = cameraRef.current
      const rect = el.getBoundingClientRect()
      // Cursor position relative to container center
      const cx = (e.clientX - rect.left - rect.width / 2) / cam.zoom
      const cy = (e.clientY - rect.top - rect.height / 2) / cam.zoom

      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1
      const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cam.zoom * zoomFactor))
      const scale = newZoom / cam.zoom

      // Adjust pan to keep cursor point fixed
      cam.x = cam.x * scale - cx * (scale - 1)
      cam.y = cam.y * scale - cy * (scale - 1)
      cam.zoom = newZoom
      clampCamera(cam)
      broadcastCamera(cam)
      forceRender((n) => n + 1)
    }

    el.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => el.removeEventListener('wheel', onWheel, true)
  }, [clampCamera, broadcastCamera])

  // Touch pinch-zoom + pan
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    let lastTouches: Touch[] = []
    let isPinching = false
    let isPanning = false

    const getTouchDist = (t: Touch[]) =>
      Math.hypot(t[1].clientX - t[0].clientX, t[1].clientY - t[0].clientY)
    const getTouchCenter = (t: Touch[]) => ({
      x: (t[0].clientX + t[1].clientX) / 2,
      y: (t[0].clientY + t[1].clientY) / 2,
    })

    const onTouchStart = (e: TouchEvent) => {
      e.stopPropagation()
      if (e.touches.length === 2) {
        e.preventDefault()
        isPinching = true
        isPanning = false
        lastTouches = [e.touches[0], e.touches[1]]
      } else if (e.touches.length === 1 && cameraRef.current.zoom > 1) {
        // Single-finger pan when zoomed in
        isPanning = true
        isPinching = false
        lastTouches = [e.touches[0]]
      }
    }

    const onTouchMove = (e: TouchEvent) => {
      const cam = cameraRef.current

      if (isPinching && e.touches.length >= 2) {
        e.preventDefault()
        e.stopPropagation()
        const curTouches = [e.touches[0], e.touches[1]]
        const oldDist = getTouchDist(lastTouches)
        const newDist = getTouchDist(curTouches)
        const oldCenter = getTouchCenter(lastTouches)
        const newCenter = getTouchCenter(curTouches)

        const rect = el.getBoundingClientRect()
        const scale = newDist / oldDist
        const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cam.zoom * scale))
        const actualScale = newZoom / cam.zoom

        // Pinch center offset
        const cx = (oldCenter.x - rect.left - rect.width / 2) / cam.zoom
        const cy = (oldCenter.y - rect.top - rect.height / 2) / cam.zoom

        cam.x = cam.x * actualScale - cx * (actualScale - 1) + (newCenter.x - oldCenter.x) / newZoom
        cam.y = cam.y * actualScale - cy * (actualScale - 1) + (newCenter.y - oldCenter.y) / newZoom
        cam.zoom = newZoom
        clampCamera(cam)
        broadcastCamera(cam)
        forceRender((n) => n + 1)
        lastTouches = curTouches
      } else if (isPanning && e.touches.length === 1 && cam.zoom > 1) {
        e.preventDefault()
        e.stopPropagation()
        const dx = (e.touches[0].clientX - lastTouches[0].clientX) / cam.zoom
        const dy = (e.touches[0].clientY - lastTouches[0].clientY) / cam.zoom
        cam.x += dx
        cam.y += dy
        clampCamera(cam)
        broadcastCamera(cam)
        forceRender((n) => n + 1)
        lastTouches = [e.touches[0]]
      }
    }

    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) isPinching = false
      if (e.touches.length < 1) isPanning = false
      lastTouches = Array.from(e.touches)
    }

    el.addEventListener('touchstart', onTouchStart, { passive: false, capture: true })
    el.addEventListener('touchmove', onTouchMove, { passive: false, capture: true })
    el.addEventListener('touchend', onTouchEnd, { capture: true })

    return () => {
      el.removeEventListener('touchstart', onTouchStart, true)
      el.removeEventListener('touchmove', onTouchMove, true)
      el.removeEventListener('touchend', onTouchEnd, true)
    }
  }, [clampCamera, broadcastCamera])

  // Double-tap to reset zoom
  const lastTapRef = useRef(0)
  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      stopEventPropagation(e)
      const now = Date.now()
      if (now - lastTapRef.current < 300) {
        // Double-tap: reset
        cameraRef.current = { zoom: 1, x: 0, y: 0 }
        broadcastCamera(cameraRef.current)
        forceRender((n) => n + 1)
      }
      lastTapRef.current = now
    },
    [broadcastCamera],
  )

  if (!src) return null

  const cam = cameraRef.current
  const tx = cam.x * cam.zoom
  const ty = cam.y * cam.zoom

  return (
    <HTMLContainer
      style={{
        width: '100%',
        height: '100%',
        pointerEvents: 'all',
      }}
      onPointerDown={onPointerDown}
      onPointerUp={stopEventPropagation}
      onPointerMove={stopEventPropagation}
      onTouchStart={stopEventPropagation}
      onTouchEnd={stopEventPropagation}
    >
      <div
        ref={containerRef}
        style={{
          width: w,
          height: h,
          overflow: 'hidden',
          touchAction: 'none',
        }}
      >
        <img
          src={src}
          draggable={false}
          style={{
            width: w,
            height: h,
            objectFit: 'contain',
            transform: `translate(${tx}px, ${ty}px) scale(${cam.zoom})`,
            transformOrigin: 'center center',
            willChange: 'transform',
          }}
        />
      </div>
    </HTMLContainer>
  )
}
