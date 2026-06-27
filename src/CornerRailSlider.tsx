import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { stopEventPropagation } from 'tldraw'

export type CornerRailSliderOption = {
  id: string
  label: string
  color?: string
  render: (active: boolean) => React.ReactNode
}

export function CornerRailSlider({
  anchorRef,
  className = '',
  ariaLabel,
  options,
  value,
  onPreview,
  onCommit,
  onTap,
  onLongPress,
}: {
  anchorRef: React.RefObject<HTMLElement | null>
  className?: string
  ariaLabel: string
  options: CornerRailSliderOption[]
  value: number
  onPreview: (idx: number) => void
  onCommit: (idx: number) => void
  onTap: () => void
  onLongPress?: () => void
}) {
  const [dragging, setDragging] = useState(false)
  const [activeValue, setActiveValue] = useState(value)
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const didDragRef = useRef(false)
  const railTrackingRef = useRef(false)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressFiredRef = useRef(false)

  const clampedValue = useMemo(
    () => Math.max(0, Math.min(options.length - 1, activeValue)),
    [activeValue, options.length]
  )

  const updateValue = useCallback((raw: string) => {
    const idx = Math.max(0, Math.min(options.length - 1, Number(raw)))
    setActiveValue(idx)
    onPreview(idx)
  }, [onPreview, options.length])

  const dispatchRailTracking = useCallback((phase: 'down' | 'move' | 'up' | 'cancel', e: React.PointerEvent<HTMLInputElement>) => {
    const event = new CustomEvent('corner-rail-track', {
      cancelable: true,
      detail: {
        phase,
        clientX: e.clientX,
        clientY: e.clientY,
        pointerId: e.pointerId,
      },
    })
    window.dispatchEvent(event)
    return event.defaultPrevented
  }, [])

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }, [])

  useEffect(() => clearLongPressTimer, [clearLongPressTimer])

  const start = useCallback((e: React.PointerEvent<HTMLInputElement>) => {
    stopEventPropagation(e)
    startRef.current = { x: e.clientX, y: e.clientY }
    didDragRef.current = false
    longPressFiredRef.current = false
    const railTracking = dispatchRailTracking('down', e)
    railTrackingRef.current = railTracking
    if (!railTracking) {
      const rect = anchorRef.current?.getBoundingClientRect() ?? null
      setAnchorRect(rect)
      setDragging(true)
      updateValue(e.currentTarget.value)
    }
    if (onLongPress) {
      clearLongPressTimer()
      longPressTimerRef.current = setTimeout(() => {
        const sx = startRef.current?.x ?? e.clientX
        const sy = startRef.current?.y ?? e.clientY
        longPressTimerRef.current = null
        longPressFiredRef.current = true
        setDragging(false)
        setAnchorRect(null)
        setActiveValue(value)
        startRef.current = null
        didDragRef.current = false
        if (railTrackingRef.current) {
          window.dispatchEvent(new CustomEvent('corner-rail-track', {
            cancelable: true,
            detail: {
              phase: 'cancel',
              clientX: sx,
              clientY: sy,
              pointerId: e.pointerId,
            },
          }))
          railTrackingRef.current = false
        }
        onLongPress()
      }, 600)
    }
  }, [anchorRef, clearLongPressTimer, dispatchRailTracking, onLongPress, updateValue, value])

  const move = useCallback((e: React.PointerEvent<HTMLInputElement>) => {
    if (longPressFiredRef.current) return
    const start = startRef.current
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6) {
      didDragRef.current = true
      clearLongPressTimer()
    }
    if (railTrackingRef.current) {
      dispatchRailTracking('move', e)
    }
  }, [clearLongPressTimer, dispatchRailTracking])

  const change = useCallback((e: React.ChangeEvent<HTMLInputElement> | React.FormEvent<HTMLInputElement>) => {
    if (longPressFiredRef.current) return
    updateValue(e.currentTarget.value)
  }, [updateValue])

  const finish = useCallback((e: React.PointerEvent<HTMLInputElement>) => {
    stopEventPropagation(e)
    clearLongPressTimer()
    if (longPressFiredRef.current) {
      setDragging(false)
      setAnchorRect(null)
      setActiveValue(value)
      startRef.current = null
      didDragRef.current = false
      longPressFiredRef.current = false
      railTrackingRef.current = false
      return
    }
    const railTracking = railTrackingRef.current
    if (railTracking) {
      dispatchRailTracking('up', e)
    }
    const idx = Math.max(0, Math.min(options.length - 1, Number(e.currentTarget.value)))
    setDragging(false)
    setAnchorRect(null)
    setActiveValue(value)
    if (!railTracking) {
      if (didDragRef.current) onCommit(idx)
      else onTap()
    }
    startRef.current = null
    didDragRef.current = false
    railTrackingRef.current = false
  }, [clearLongPressTimer, dispatchRailTracking, onCommit, onTap, options.length, value])

  const cancel = useCallback((e: React.PointerEvent<HTMLInputElement>) => {
    stopEventPropagation(e)
    clearLongPressTimer()
    if (railTrackingRef.current) {
      dispatchRailTracking('cancel', e)
    }
    setDragging(false)
    setAnchorRect(null)
    setActiveValue(value)
    startRef.current = null
    didDragRef.current = false
    longPressFiredRef.current = false
    railTrackingRef.current = false
  }, [clearLongPressTimer, dispatchRailTracking, value])

  const style = anchorRect ? {
    '--corner-rail-right': `${window.innerWidth - anchorRect.right}px`,
    '--corner-rail-bottom': `${window.innerHeight - anchorRect.bottom}px`,
    '--corner-rail-count': options.length,
  } as React.CSSProperties : {
    '--corner-rail-count': options.length,
  } as React.CSSProperties

  return (
    <>
      {dragging && anchorRect && (
        <div className={`corner-rail-slider ${className}`} style={style}>
          {options.map((option, i) => (
            <div
              key={option.id}
              className={`corner-rail-slider-slot${i === clampedValue ? ' active' : ''}`}
              style={{ '--corner-rail-color': option.color || 'currentColor' } as React.CSSProperties}
              title={option.label}
            >
              {option.render(i === clampedValue)}
            </div>
          ))}
        </div>
      )}
      <input
        className={`corner-rail-slider-range ${className}`}
        type="range"
        min={0}
        max={Math.max(0, options.length - 1)}
        step={1}
        value={dragging ? clampedValue : value}
        aria-label={ariaLabel}
        style={style}
        onPointerDown={start}
        onPointerMove={move}
        onInput={change}
        onChange={change}
        onPointerUp={finish}
        onPointerCancel={cancel}
        onClick={stopEventPropagation}
      />
    </>
  )
}
