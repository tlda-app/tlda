import React, { useCallback, useMemo, useRef, useState } from 'react'
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
}: {
  anchorRef: React.RefObject<HTMLElement | null>
  className?: string
  ariaLabel: string
  options: CornerRailSliderOption[]
  value: number
  onPreview: (idx: number) => void
  onCommit: (idx: number) => void
  onTap: () => void
}) {
  const [dragging, setDragging] = useState(false)
  const [activeValue, setActiveValue] = useState(value)
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const didDragRef = useRef(false)

  const clampedValue = useMemo(
    () => Math.max(0, Math.min(options.length - 1, activeValue)),
    [activeValue, options.length]
  )

  const updateValue = useCallback((raw: string) => {
    const idx = Math.max(0, Math.min(options.length - 1, Number(raw)))
    setActiveValue(idx)
    onPreview(idx)
  }, [onPreview, options.length])

  const start = useCallback((e: React.PointerEvent<HTMLInputElement>) => {
    stopEventPropagation(e)
    startRef.current = { x: e.clientX, y: e.clientY }
    didDragRef.current = false
    const rect = anchorRef.current?.getBoundingClientRect() ?? null
    setAnchorRect(rect)
    setDragging(true)
    updateValue(e.currentTarget.value)
  }, [anchorRef, updateValue])

  const move = useCallback((e: React.PointerEvent<HTMLInputElement>) => {
    const start = startRef.current
    if (!start) return
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 6) {
      didDragRef.current = true
    }
  }, [])

  const change = useCallback((e: React.ChangeEvent<HTMLInputElement> | React.FormEvent<HTMLInputElement>) => {
    updateValue(e.currentTarget.value)
  }, [updateValue])

  const finish = useCallback((e: React.PointerEvent<HTMLInputElement>) => {
    stopEventPropagation(e)
    const idx = Math.max(0, Math.min(options.length - 1, Number(e.currentTarget.value)))
    setDragging(false)
    setAnchorRect(null)
    setActiveValue(value)
    if (didDragRef.current) onCommit(idx)
    else onTap()
    startRef.current = null
    didDragRef.current = false
  }, [onCommit, onTap, options.length, value])

  const cancel = useCallback((e: React.PointerEvent<HTMLInputElement>) => {
    stopEventPropagation(e)
    setDragging(false)
    setAnchorRect(null)
    setActiveValue(value)
    startRef.current = null
    didDragRef.current = false
  }, [value])

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
