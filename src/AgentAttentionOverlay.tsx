import { useEffect, useRef, useState, useCallback } from 'react'
import type { Editor } from 'tldraw'
import { onAgentAttention } from './useYjsSync'
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
            <svg width={LOGO_SIZE} height={LOGO_SIZE} viewBox="0 0 248 248" fill="currentColor">
              <path d="M0 211 C25 198, 37 37, 87 37 C112 37, 112 112, 124 112 C136 112, 144 149, 248 37 C223 50, 211 211, 161 211 C136 211, 136 161, 124 161 C112 161, 104 99, 0 211Z"/>
            </svg>
          </div>
        )
      })}
    </div>
  )
}
