import { useEffect, useState } from 'react'
import { subscribePhoneLaneDrag, type PhoneLaneDragState } from './useFleetGestures'

// Fill-up arrow for the phone lane transition. While you drag horizontally the
// panes stay static; this chevron fills toward the edge of the incoming lane and
// "arms" once you've dragged far enough that releasing will transition. Only ever
// visible during an active phone-lane drag (the signal is phone-only).
const IDLE: PhoneLaneDragState = { active: false, progress: 0, dir: 0, armed: false }

export function PhoneLaneArrow() {
  const [s, setS] = useState<PhoneLaneDragState>(IDLE)
  useEffect(() => subscribePhoneLaneDrag(setS), [])

  if (!s.active || s.dir === 0) return null

  // dir +1 pulls toward the agents lane, which slides in from the LEFT; dir -1
  // toward the document lane, sliding in from the RIGHT. Point the chevron at the
  // edge the incoming lane comes from.
  const fromLeft = s.dir === 1
  const chevronOpacity = 0.35 + 0.65 * s.progress

  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        top: '50%',
        [fromLeft ? 'left' : 'right']: 8,
        transform: `translateY(-50%) scale(${0.82 + 0.18 * s.progress})`,
        zIndex: 60,
        pointerEvents: 'none',
        width: 34,
        height: 56,
        borderRadius: 10,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: s.armed
          ? 'rgba(120, 160, 255, 0.85)'
          : `rgba(140, 140, 150, ${0.10 + 0.26 * s.progress})`,
        boxShadow: s.armed ? '0 0 12px rgba(120, 160, 255, 0.45)' : 'none',
        transition: 'background 0.08s linear, box-shadow 0.08s linear',
      }}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        style={{ opacity: chevronOpacity, transform: fromLeft ? 'none' : 'scaleX(-1)' }}
      >
        <path
          d="M15 5 L8 12 L15 19"
          stroke={s.armed ? '#fff' : 'rgba(255, 255, 255, 0.85)'}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}
