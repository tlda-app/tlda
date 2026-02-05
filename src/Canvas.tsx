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

    // Monitor for DOM changes
    const container = document.querySelector('.tl-container')
    if (container) {
      const observer = new MutationObserver((mutations) => {
        console.log('[Canvas] DOM mutation:', mutations.length, 'changes')
        if (container.children.length === 0) {
          console.log('[Canvas] CONTAINER EMPTIED!')
        }
      })
      observer.observe(container, { childList: true, subtree: true })
      return () => observer.disconnect()
    }

    return () => console.log('[Canvas] UNMOUNTING!')
  }, [])

  // Absolute minimal - no props
  return <Tldraw />
}
