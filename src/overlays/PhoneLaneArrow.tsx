import { useEffect, useState } from 'react'
import { useEditor } from 'tldraw'
import { isPhonePaneStackMode, phoneLaneCommitPx, subscribePhoneLaneDrag, type PhoneLaneDragState } from './useFleetGestures'

// Big center-screen lane-transition arrow. Within one continuous drag it appears
// subtly and FILLS toward its point as you swipe; a deliberate ~75%-of-screen
// swipe fills it fully ("armed") and releasing there commits the lane change.
// Short/choppy pans never fill it, so you interact with the page naturally. Uses
// the annotation-viewer arrow shape. Only visible during an active phone-lane drag.
const IDLE: PhoneLaneDragState = { active: false, progress: 0, dir: 0, armed: false }

// Annotation-viewer arrow (viewBox 0 0 250 250), left-, right-, and up-pointing.
const LEFT_ARROW = 'M238 125 H12 M80 12 L12 125 L80 238'
const RIGHT_ARROW = 'M12 125 H238 M170 12 L238 125 L170 238'
const UP_ARROW = 'M125 238 V12 M12 80 L125 12 L238 80'

export function PhoneLaneArrow() {
  const editor = useEditor()
  const [s, setS] = useState<PhoneLaneDragState>(IDLE)
  useEffect(() => subscribePhoneLaneDrag(setS), [])

  if (!s.active || s.dir === 0 || !isPhonePaneStackMode(editor)) return null

  // dir +1 pulls toward the agents lane (points left); -1 toward the document
  // lane (points right). Stack push/pop use the same visual channel with their
  // own kind so local row/modal code cannot drift into a different arrow system.
  // Fill grows from the tail toward the point (destination/action).
  const pointUp = s.kind === 'stack-pop' || s.dir === 'up'
  const pointLeft = s.kind === 'item-push' || (!pointUp && s.dir === 1)
  const path = pointUp ? UP_ARROW : pointLeft ? LEFT_ARROW : RIGHT_ARROW
  const arrowWidthPx = s.arrowWidthPx || phoneLaneCommitPx()
  const clipInset = pointUp
    ? `inset(${(1 - s.progress) * 100}% 0 0 0)` // reveal bottom(tail) → top(head)
    : pointLeft
      ? `inset(0 0 0 ${(1 - s.progress) * 100}%)` // reveal right(tail) → left(head)
      : `inset(0 ${(1 - s.progress) * 100}% 0 0)` // reveal left(tail) → right(head)

  const stroke = s.armed ? 'rgba(120, 160, 255, 0.95)' : 'rgba(230, 235, 245, 0.9)'
  const originLeft = typeof s.originX === 'number'
    ? Math.max(arrowWidthPx / 2, Math.min(window.innerWidth - arrowWidthPx / 2, s.originX))
    : undefined
  const originTop = typeof s.originY === 'number'
    ? Math.max(arrowWidthPx / 2, Math.min(window.innerHeight - arrowWidthPx / 2, s.originY))
    : undefined

  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        top: originTop ?? '50%',
        left: originLeft ?? '50%',
        transform: 'translate(-50%, -50%)',
        width: arrowWidthPx,
        aspectRatio: '1 / 1',
        zIndex: 60,
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        transition: 'opacity 0.08s linear',
      }}
    >
      {/* Faint full arrow — the "channel" that fills */}
      <svg viewBox="0 0 250 250" style={{ position: 'absolute', width: '100%', height: '100%' }} fill="none">
        <path d={path} stroke="rgba(200, 205, 215, 0.18)" strokeWidth={40} strokeLinecap="square" strokeLinejoin="miter" />
      </svg>
      {/* Bright fill, revealed to `progress` */}
      <svg
        viewBox="0 0 250 250"
        style={{ position: 'absolute', width: '100%', height: '100%', clipPath: clipInset, filter: s.armed ? 'drop-shadow(0 0 8px rgba(120,160,255,0.5))' : 'none' }}
        fill="none"
      >
        <path d={path} stroke={stroke} strokeWidth={40} strokeLinecap="square" strokeLinejoin="miter" />
      </svg>
    </div>
  )
}
