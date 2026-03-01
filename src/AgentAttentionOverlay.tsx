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
            <svg width={LOGO_SIZE} height={LOGO_SIZE} viewBox="4 2 24 16" fill="currentColor">
              <defs>
                <mask id={`af-${flash.agent}`}>
                  <rect width="32" height="32" fill="white"/>
                  <g transform="rotate(180, 15.97, 18.5)">
                    <path fill="black" d="M13.125 18.8843C13.125 18.1109 13.3893 17.4548 13.918 16.9158C14.4696 16.3533 15.1362 16.0721 15.9176 16.0721C16.6531 16.0721 17.2967 16.3533 17.8484 16.9158C18.4 17.4548 18.7218 18.0641 18.8137 18.7437C18.9976 20.0092 18.7677 21.2629 18.1242 22.505C17.5036 23.747 16.6072 24.6961 15.435 25.3523C14.7914 25.7273 14.2627 25.7155 13.849 25.3172C13.4583 24.9422 13.5732 24.4969 14.1938 23.9814C14.5386 23.7236 14.8259 23.3955 15.0557 22.9971C15.2856 22.5987 15.435 22.1886 15.5039 21.7668C15.5269 21.5793 15.4465 21.4856 15.2626 21.4856C14.8029 21.4621 14.3317 21.2043 13.849 20.7122C13.3663 20.2201 13.125 19.6108 13.125 18.8843Z"/>
                  </g>
                </mask>
              </defs>
              <circle cx="16" cy="9.25" r="3.2" fill="currentColor" mask={`url(#af-${flash.agent})`}/>
            </svg>
          </div>
        )
      })}
    </div>
  )
}
