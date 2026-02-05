import { useEffect } from 'react'
import { Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'

interface CanvasProps {
  roomId: string
  onLoadPdf: () => void
}

export function Canvas({ roomId: _roomId, onLoadPdf: _onLoadPdf }: CanvasProps) {
  console.log('[Canvas] Render')

  useEffect(() => {
    console.log('[Canvas] Mounted')

    // Heartbeat every 500ms to see when things die
    let count = 0
    const heartbeat = setInterval(() => {
      const container = document.querySelector('.tl-container')
      const canvas = document.querySelector('.tl-canvas')
      const hasContent = container && container.innerHTML.length > 100
      console.log(`[Heartbeat ${count++}] container=${!!container} canvas=${!!canvas} content=${hasContent}`)

      if (container && !hasContent) {
        console.log('[Heartbeat] CONTENT GONE! innerHTML length:', container.innerHTML.length)
        console.log('[Heartbeat] innerHTML preview:', container.innerHTML.substring(0, 200))
      }
    }, 500)

    // Global error catcher
    window.onerror = (msg, src, line, col, err) => {
      console.log('[GlobalError]', msg, src, line, col, err)
    }
    window.onunhandledrejection = (e) => {
      console.log('[UnhandledRejection]', e.reason)
    }

    return () => {
      clearInterval(heartbeat)
      console.log('[Canvas] UNMOUNTING!')
    }
  }, [])

  // Absolute minimal - no props
  return <Tldraw />
}
