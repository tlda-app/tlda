import { useEffect, useRef, useState, useCallback } from 'react'
import type { Editor } from 'tldraw'
import { onAgentAttention } from '../useYjsSync'
import './AgentAttentionOverlay.css'

const FLASH_DURATION = 60000
const LOGO_SIZE = 36

interface Flash {
  id: number
  canvasX: number
  canvasY: number
  born: number
  agent?: string
}

let nextId = 0

export function AgentAttentionOverlay({ editor }: { editor: Editor }) {
  const [flashes, setFlashes] = useState<Flash[]>([])
  const flashesRef = useRef(flashes)
  flashesRef.current = flashes

  // Subscribe to attention signals
  useEffect(() => {
    return onAgentAttention((signal) => {
      const flash: Flash = {
        id: nextId++,
        canvasX: signal.x,
        canvasY: signal.y,
        born: Date.now(),
        agent: signal.agent,
      }
      setFlashes(prev => [...prev, flash])
      // Auto-remove after animation completes
      setTimeout(() => {
        setFlashes(prev => prev.filter(f => f.id !== flash.id))
      }, FLASH_DURATION + 100)
    })
  }, [])

  // Project canvas→screen on every frame while flashes are active
  const positionsRef = useRef<Map<number, { x: number; y: number }>>(new Map())
  const rafRef = useRef<number | null>(null)
  const [, forceRender] = useState(0)

  const updatePositions = useCallback(() => {
    const current = flashesRef.current
    if (current.length === 0) {
      rafRef.current = null
      return
    }
    const map = new Map<number, { x: number; y: number }>()
    for (const flash of current) {
      const screen = editor.pageToScreen({ x: flash.canvasX, y: flash.canvasY })
      map.set(flash.id, screen)
    }
    positionsRef.current = map
    forceRender(n => n + 1)
    rafRef.current = requestAnimationFrame(updatePositions)
  }, [editor])

  useEffect(() => {
    if (flashes.length > 0 && rafRef.current == null) {
      rafRef.current = requestAnimationFrame(updatePositions)
    }
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [flashes.length, updatePositions])

  if (flashes.length === 0) return null

  return (
    <div className="agent-attention-overlay">
      {flashes.map(flash => {
        const pos = positionsRef.current.get(flash.id)
        if (!pos) return null
        return (
          <div
            key={flash.id}
            className="agent-attention-flash"
            data-agent={flash.agent}
            style={{
              left: pos.x - LOGO_SIZE / 2,
              top: pos.y - LOGO_SIZE / 2,
            }}
          >
            <svg width={LOGO_SIZE} height={LOGO_SIZE} viewBox="4 3.5 24 16" fill="currentColor">
              <path fill="currentColor" d="M12.8,10.75c0,-1.76731 1.43269,-3.2 3.2,-3.2c1.76731,0 3.2,1.43269 3.2,3.2c0,1.61101 -1.19047,2.94396 -2.7397,3.16714c-0.02561,-0.04541 -0.03368,-0.10672 -0.0242,-0.18394c0.0689,-0.4218 0.2183,-0.8319 0.4482,-1.2303c0.2298,-0.3984 0.5171,-0.7265 0.8619,-0.9843c0.6206,-0.5155 0.7355,-0.9608 0.3448,-1.3358c-0.4137,-0.3983 -0.9424,-0.4101 -1.586,-0.0351c-1.1722,0.6562 -2.0686,1.6053 -2.6892,2.8473c-0.01089,0.02102 -0.02166,0.04203 -0.03231,0.06306c-0.6062,-0.5823 -0.98349,-1.40112 -0.98349,-2.30806z"/>
            </svg>
          </div>
        )
      })}
    </div>
  )
}
