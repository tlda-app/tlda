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
  const [active, setActive] = useState<{ label: string; x: number } | null>(null)

  const pickTarget = useCallback((clientX: number, clientY: number): PersistentRailTarget | null => {
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
    if (!best) return null

    const railRect = rail.getBoundingClientRect()
    const buttonRect = best.getBoundingClientRect()
    const action = best.dataset.composerRailAction || ''
    const values = (best.dataset.composerRailValues || '').split(',').map(v => v.trim()).filter(Boolean)
    const labels = (best.dataset.composerRailLabels || '').split('|').map(v => v.trim())
    if (values.length > 0) {
      const rawPosition = buttonRect.width > 0 ? (clientX - buttonRect.left) / buttonRect.width : 0
      const clampedPosition = Math.max(0, Math.min(0.999999, rawPosition))
      const index = Math.min(values.length - 1, Math.floor(clampedPosition * values.length))
      return {
        action,
        value: values[index],
        label: labels[index] || values[index],
        button: best,
        x: buttonRect.left + buttonRect.width * ((index + 0.5) / values.length) - railRect.left,
      }
    }

    return {
      action,
      value: null,
      label: best.dataset.composerRailLabel || best.title || best.getAttribute('aria-label') || '',
      button: best,
      x: buttonRect.left + buttonRect.width / 2 - railRect.left,
    }
  }, [])

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
      pointAt(pickTarget(e.clientX, e.clientY))
    }}
    onPointerMove={(e) => {
      if (pointerRef.current !== e.pointerId) return
      stopEventPropagation(e)
      pointAt(pickTarget(e.clientX, e.clientY))
    }}
    onPointerUp={(e) => {
      if (pointerRef.current !== e.pointerId) return
      stopEventPropagation(e)
      pointerRef.current = null
      const target = pickTarget(e.clientX, e.clientY)
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
      setActive(null)
    }}
  >
    {active && <div className="corner-button-slider-preview" style={{ left: active.x }}>{active.label}</div>}
    {children}
  </div>
}
