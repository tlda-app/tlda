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
      switch (signal.phase) {
        case 'compiling':  label = 'compiling';  break
        case 'converting': label = 'converting'; break
        case 'hot':        label = 'patched';    break
        case 'done':       label = 'done';       break
        case 'failed':     label = 'failed';     break
      }
      setPhase(label)
      setDetail(signal.detail)
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
    <div className="build-progress-row" onPointerDown={e => e.stopPropagation()}>
      <span className="build-progress-pill">{phase}</span>
      {detail && <span className="build-progress-detail">{detail}</span>}
    </div>
  )
}
