/**
 * ToolNameHud — single shared "current tool" indicator pill at top-center.
 *
 * Both the button-slider (PhoneHighlighterButton) and the ghost slider
 * (HighlighterSlider) drive this component via the `toolNameHud` event bus.
 * Only one pill ever exists in the DOM, so the two controllers can't
 * fight over their own copies and leave a stuck pill behind.
 */
import { useEffect, useState } from 'react'

interface HudState {
  label: string
  color: string
  fading: boolean
}

const listeners = new Set<(s: HudState | null) => void>()
let current: HudState | null = null

function emit(next: HudState | null) {
  current = next
  listeners.forEach(fn => fn(next))
}

export const toolNameHud = {
  show(label: string, color: string) {
    emit({ label, color, fading: false })
  },
  fade() {
    if (current) emit({ ...current, fading: true })
  },
  hide() {
    emit(null)
  },
}

export function ToolNameHud() {
  const [state, setState] = useState<HudState | null>(current)
  useEffect(() => {
    listeners.add(setState)
    return () => { listeners.delete(setState) }
  }, [])
  if (!state) return null
  return (
    <div style={{
      position: 'fixed',
      top: 12,
      left: '50%',
      transform: 'translateX(-50%)',
      background: state.color,
      color: '#fff',
      padding: '4px 14px',
      borderRadius: 12,
      fontSize: 13,
      fontWeight: 500,
      opacity: state.fading ? 0 : 0.85,
      transition: 'opacity 0.4s ease',
      pointerEvents: 'none',
      zIndex: 9999,
      whiteSpace: 'nowrap',
      letterSpacing: '0.03em',
      boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
    }}>
      {state.label}
    </div>
  )
}
