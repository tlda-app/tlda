import React from 'react'

export type CornerButtonSliderOption = {
  id: string
  label: string
  color?: string
  render: (active: boolean) => React.ReactNode
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
}: {
  anchorRect: DOMRect
  className?: string
  options: CornerButtonSliderOption[]
  activeIndex: number | null
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
        >
          {option.render(i === activeIndex)}
        </div>
      ))}
    </div>
  )
}
