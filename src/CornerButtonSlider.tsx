import React, { useCallback, useRef, useState } from 'react'
import { stopEventPropagation } from 'tldraw'
import { log } from './logger'

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
  x: number
}

type PersistentRailValueSource = {
  action: string
  values: string[]
  labels: string[]
  button: HTMLButtonElement
  rect: DOMRect
  currentIndex: number
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
  const pointerStartRef = useRef<{ clientX: number; clientY: number; button: HTMLButtonElement | null } | null>(null)
  const valueSourceRef = useRef<PersistentRailValueSource | null>(null)
  // What the rail last told the reader it would do. See `pointAt`.
  const pointedRef = useRef<PersistentRailTarget | null>(null)
  const [active, setActive] = useState<{ label: string; x: number } | null>(null)

  const valueSourceForButton = useCallback((button: HTMLButtonElement | null): PersistentRailValueSource | null => {
    if (!button) return null
    const values = (button.dataset.composerRailValues || '').split(',').map(value => value.trim()).filter(Boolean)
    if (values.length === 0) return null
    const currentValue = button.dataset.composerRailCurrentValue || ''
    const currentIndex = Math.max(0, values.indexOf(currentValue))
    return {
      action: button.dataset.composerRailAction || '',
      values,
      labels: (button.dataset.composerRailLabels || '').split('|').map(value => value.trim()),
      button,
      rect: button.getBoundingClientRect(),
      currentIndex,
    }
  }, [])

  const targetForValueSource = useCallback((source: PersistentRailValueSource, clientX: number): PersistentRailTarget | null => {
    const rail = railRef.current
    if (!rail) return null
    const railRect = rail.getBoundingClientRect()
    const slotWidth = Math.max(44, source.rect.width)
    const left = source.rect.left + source.rect.width / 2 - slotWidth * (source.currentIndex + 0.5)
    const index = Math.max(0, Math.min(source.values.length - 1, Math.floor((clientX - left) / slotWidth)))
    return {
      action: source.action,
      value: source.values[index],
      label: source.labels[index] || source.values[index],
      x: left + slotWidth * (index + 0.5) - railRect.left,
    }
  }, [])

  const pickButton = useCallback((clientX: number, clientY: number) => {
    const rail = railRef.current
    if (!rail) return null
    for (const element of document.elementsFromPoint(clientX, clientY)) {
      const button = element.closest<HTMLButtonElement>('[data-composer-rail-action]:not(:disabled)')
      if (button && rail.contains(button)) return button
    }
    return null
  }, [])

  const targetForButton = useCallback((button: HTMLButtonElement | null): PersistentRailTarget | null => {
    const rail = railRef.current
    if (!rail || !button) return null
    const railRect = rail.getBoundingClientRect()
    const buttonRect = button.getBoundingClientRect()
    return {
      action: button.dataset.composerRailAction || '',
      value: null,
      label: button.dataset.composerRailLabel || button.title || button.getAttribute('aria-label') || '',
      x: buttonRect.left + buttonRect.width / 2 - railRect.left,
    }
  }, [])

  const targetAt = useCallback((source: PersistentRailValueSource | null, clientX: number, clientY: number) => {
    const button = pickButton(clientX, clientY)
    if (button && button !== source?.button) return targetForButton(button)
    return source ? targetForValueSource(source, clientX) : targetForButton(button)
  }, [pickButton, targetForButton, targetForValueSource])

  // The hover and the commit used to be two independent computations of the
  // same thing, and they are allowed to disagree: `targetAt` re-runs
  // `pickButton` at the release coordinate, and a pointerup's coordinate is not
  // the last pointermove's. A finger that drifts a pixel off the button as it
  // lifts -- into the `gap: 3px` between buttons, into the coarse-pointer hit
  // slop band, or off the rail -- makes `pickButton` return null, so the whole
  // commit block was skipped while the highlight from the last move was still
  // on screen. Skip: "It's not like it's missing what you're over. The hover is
  // right. It isn't fucking doing it."
  //
  // So the hover is now the record, and the commit reads it. One fact, one
  // encoding: whatever the rail last told you it would do is what it does.
  const pointAt = useCallback((target: PersistentRailTarget | null) => {
    pointedRef.current = target
    if (!target) { setActive(null); return }
    setActive({
      label: target.label,
      x: target.x,
    })
  }, [])

  return <div
    ref={railRef}
    // `dragging` while a pointer is down on the rail, because :hover stops
    // matching the moment a drag takes pointer capture — Skip: "it goes away
    // once you click, which is not great. In a drag, the background goes away."
    className={`persistent-corner-button-slider ${className}${active ? ' rail-dragging' : ''}`}
    onPointerDownCapture={(e) => {
      stopEventPropagation(e)
      e.preventDefault()
      // A previous gesture that never reached `onPointerUp` at all. The rail's
      // release is a bubble-phase React handler, and `dragCoordinator` installs
      // a document capture-phase `pointerup` that calls `stopImmediatePropagation`
      // whenever any fleet drag is claimed, so a stale claim from another shape
      // swallows this rail's commit before React sees it. That is a second and
      // separate route to "the hover was right and nothing happened", it is not
      // fixed here, and this is the record that would show it.
      if (pointerRef.current !== null) {
        log.metric('composer-rail', 'previous gesture never delivered pointerup', {
          strandedPointerId: pointerRef.current,
          pointerType: e.pointerType,
        })
      }
      pointerRef.current = e.pointerId
      e.currentTarget.setPointerCapture(e.pointerId)
      const button = pickButton(e.clientX, e.clientY)
      pointerStartRef.current = { clientX: e.clientX, clientY: e.clientY, button }
      valueSourceRef.current = valueSourceForButton(button)
      pointAt(targetAt(valueSourceRef.current, e.clientX, e.clientY))
    }}
    onPointerMove={(e) => {
      if (pointerRef.current !== e.pointerId) return
      stopEventPropagation(e)
      const source = valueSourceRef.current
      pointAt(targetAt(source, e.clientX, e.clientY))
    }}
    onPointerUp={(e) => {
      if (pointerRef.current !== e.pointerId) return
      stopEventPropagation(e)
      pointerRef.current = null
      const source = valueSourceRef.current
      const start = pointerStartRef.current
      valueSourceRef.current = null
      pointerStartRef.current = null
      const pointed = pointedRef.current
      const released = targetAt(source, e.clientX, e.clientY)
      // The release point decides, and the hover decides when the release point
      // resolves to nothing. Releasing on a real target still commits that
      // target -- this only recovers the case where the geometric test comes
      // back empty and the rail was nonetheless showing you an action.
      const target = released ?? pointed
      if (!released && pointed) {
        log.metric('composer-rail', 'release hit-test empty; committed the pointed target', {
          action: pointed.action,
          value: pointed.value,
          pointerType: e.pointerType,
        })
      }
      pointAt(target)
      if (target) {
        const dx = start ? e.clientX - start.clientX : 0
        const dy = start ? e.clientY - start.clientY : 0
        const noTravel = Math.hypot(dx, dy) < 4
        const value = source && !noTravel ? target.value : null
        if (target.action) onSelect?.(target.action, value)
        else log.metric('composer-rail', 'target carried no action; nothing committed', { label: target.label })
      }
      pointedRef.current = null
      window.setTimeout(() => setActive(null), 140)
    }}
    onPointerCancel={(e) => {
      if (pointerRef.current !== e.pointerId) return
      stopEventPropagation(e)
      pointerRef.current = null
      valueSourceRef.current = null
      pointerStartRef.current = null
      pointedRef.current = null
      setActive(null)
    }}
  >
    {active && <div className="corner-button-slider-preview" style={{ left: active.x }}>{active.label}</div>}
    {children}
  </div>
}
