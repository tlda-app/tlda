import React, { useCallback, useRef, useState } from 'react'
import { stopEventPropagation } from 'tldraw'

export type CornerButtonSliderOption = {
  id: string
  label: string
  color?: string
  render: (active: boolean) => React.ReactNode
}

type PersistentRailTarget = {
  action: string
  value: string | null
  label: string
  button: HTMLButtonElement
  x: number
}

type PersistentRailValueSource = {
  action: string
  values: string[]
  labels: string[]
  button: HTMLButtonElement
}

export function pickCornerSliderIndex({
  clientX,
  anchorRect,
  count,
  slotWidth = 44,
  gap = 4,
}: {
  clientX: number
  anchorRect: DOMRect
  count: number
  slotWidth?: number
  gap?: number
}) {
  const slot = slotWidth + gap
  const distFromButtonLeft = anchorRect.left - clientX
  // Slots render left-to-right (index 0 leftmost) while the slider box is
  // right-anchored at the button's left edge, so the slot nearest the button is
  // the LAST index. Map distance-from-button onto that ordering so the
  // highlighted slot matches the finger position instead of mirroring it.
  const fromButton = Math.max(0, Math.min(count - 1, Math.floor(distFromButtonLeft / slot)))
  return count - 1 - fromButton
}

export function CornerButtonSlider({
  anchorRect,
  className = '',
  options,
  activeIndex,
  onSelect,
}: {
  anchorRect: DOMRect
  className?: string
  options: CornerButtonSliderOption[]
  activeIndex: number | null
  onSelect?: (index: number) => void
}) {
  return (
    <div
      className={`corner-button-slider ${className}`}
      style={{
        bottom: `${window.innerHeight - anchorRect.bottom}px`,
        right: `${window.innerWidth - anchorRect.left}px`,
      }}
    >
      {options.map((option, i) => (
        <div
          key={option.id}
          className={`corner-button-slider-slot${i === activeIndex ? ' active' : ''}`}
          style={{ '--corner-button-slider-color': option.color || 'currentColor' } as React.CSSProperties}
          title={option.label}
          onPointerDown={stopEventPropagation}
          onPointerUp={stopEventPropagation}
          onClick={(e) => {
            stopEventPropagation(e)
            onSelect?.(i)
          }}
        >
          {option.render(i === activeIndex)}
        </div>
      ))}
    </div>
  )
}

/** The always-visible form of the corner slider. Its children remain ordinary
 * buttons, while the shared rail owns press-drag-release selection and the
 * lifted label so touch behavior stays identical wherever the slider is used. */
export function PersistentCornerButtonSlider({
  className = '',
  children,
  onSelect,
}: {
  className?: string
  children: React.ReactNode
  onSelect?: (action: string, value: string | null) => void
}) {
  const railRef = useRef<HTMLDivElement>(null)
  const pointerRef = useRef<number | null>(null)
  const valueSourceRef = useRef<PersistentRailValueSource | null>(null)
  const [active, setActive] = useState<{ label: string; x: number } | null>(null)

  const valueSourceForButton = useCallback((button: HTMLButtonElement | null): PersistentRailValueSource | null => {
    if (!button) return null
    const values = (button.dataset.composerRailValues || '').split(',').map(v => v.trim()).filter(Boolean)
    if (values.length === 0) return null
    return {
      action: button.dataset.composerRailAction || '',
      values,
      labels: (button.dataset.composerRailLabels || '').split('|').map(v => v.trim()),
      button,
    }
  }, [])

  const targetForValueSource = useCallback((source: PersistentRailValueSource, clientX: number): PersistentRailTarget | null => {
    const rail = railRef.current
    if (!rail) return null
    const railRect = rail.getBoundingClientRect()
    const rawPosition = railRect.width > 0 ? (clientX - railRect.left) / railRect.width : 0
    const clampedPosition = Math.max(0, Math.min(0.999999, rawPosition))
    const index = Math.min(source.values.length - 1, Math.floor(clampedPosition * source.values.length))
    return {
      action: source.action,
      value: source.values[index],
      label: source.labels[index] || source.values[index],
      button: source.button,
      x: railRect.width * ((index + 0.5) / source.values.length),
    }
  }, [])

  const pickButton = useCallback((clientX: number, clientY: number) => {
    const rail = railRef.current
    if (!rail) return null
    const buttons = Array.from(rail.querySelectorAll<HTMLButtonElement>('[data-composer-rail-action]:not(:disabled)'))
    let best: HTMLButtonElement | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const button of buttons) {
      const rect = button.getBoundingClientRect()
      const distance = Math.hypot(clientX - (rect.left + rect.width / 2), clientY - (rect.top + rect.height / 2))
      if (distance < bestDistance) { best = button; bestDistance = distance }
    }
    return best
  }, [])

  const pickTarget = useCallback((clientX: number, clientY: number): PersistentRailTarget | null => {
    const rail = railRef.current
    if (!rail) return null
    const best = pickButton(clientX, clientY)
    if (!best) return null
    const railRect = rail.getBoundingClientRect()
    const buttonRect = best.getBoundingClientRect()
    const action = best.dataset.composerRailAction || ''
    const source = valueSourceForButton(best)
    if (source) return targetForValueSource(source, clientX)

    return {
      action,
      value: null,
      label: best.dataset.composerRailLabel || best.title || best.getAttribute('aria-label') || '',
      button: best,
      x: buttonRect.left + buttonRect.width / 2 - railRect.left,
    }
  }, [pickButton, targetForValueSource, valueSourceForButton])

  const pointAt = useCallback((target: PersistentRailTarget | null) => {
    if (!target) { setActive(null); return }
    setActive({
      label: target.label,
      x: target.x,
    })
  }, [])

  return <div
    ref={railRef}
    className={`persistent-corner-button-slider ${className}`}
    onPointerDown={(e) => {
      stopEventPropagation(e)
      e.preventDefault()
      pointerRef.current = e.pointerId
      e.currentTarget.setPointerCapture(e.pointerId)
      const button = pickButton(e.clientX, e.clientY)
      const source = valueSourceForButton(button)
      valueSourceRef.current = source
      pointAt(source ? targetForValueSource(source, e.clientX) : pickTarget(e.clientX, e.clientY))
    }}
    onPointerMove={(e) => {
      if (pointerRef.current !== e.pointerId) return
      stopEventPropagation(e)
      const source = valueSourceRef.current
      pointAt(source ? targetForValueSource(source, e.clientX) : pickTarget(e.clientX, e.clientY))
    }}
    onPointerUp={(e) => {
      if (pointerRef.current !== e.pointerId) return
      stopEventPropagation(e)
      pointerRef.current = null
      const source = valueSourceRef.current
      valueSourceRef.current = null
      const target = source ? targetForValueSource(source, e.clientX) : pickTarget(e.clientX, e.clientY)
      pointAt(target)
      if (target) {
        if (target.value !== null) onSelect?.(target.action, target.value)
        else target.button.click()
      }
      window.setTimeout(() => setActive(null), 140)
    }}
    onPointerCancel={(e) => {
      if (pointerRef.current !== e.pointerId) return
      stopEventPropagation(e)
      pointerRef.current = null
      valueSourceRef.current = null
      setActive(null)
    }}
  >
    {active && <div className="corner-button-slider-preview" style={{ left: active.x }}>{active.label}</div>}
    {children}
  </div>
}
