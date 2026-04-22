import { useState, useEffect, useRef } from 'react'
import { onBuildProgressSignal } from '../useYjsSync'
import './BuildProgressPill.css'

export function BuildProgressPill() {
  const [phase, setPhase] = useState<string | null>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [visible, setVisible] = useState(false)
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return onBuildProgressSignal((signal) => {
      let label = ''
      let detail = signal.detail
      switch (signal.phase) {
        case 'compiling':  label = 'compiling';  break
        case 'converting': break
        case 'hot':        break
        case 'done':       label = 'compiling'; detail = `done ${signal.detail || ''}`.trim(); break
        case 'failed':     label = 'failed';     break
      }
      if (!label) return
      setPhase(label)
      setDetail(detail)
      setVisible(true)

      if (fadeTimer.current) clearTimeout(fadeTimer.current)

      if (signal.phase === 'done' || signal.phase === 'failed') {
        fadeTimer.current = setTimeout(() => {
          setVisible(false)
          fadeTimer.current = null
        }, 4000)
      }
    })
  }, [])

  if (!visible || !phase) return null

  return (
    <span className="build-progress-text" onPointerDown={e => e.stopPropagation()}>
      {phase}{detail ? ` ${detail}` : ''}
    </span>
  )
}
