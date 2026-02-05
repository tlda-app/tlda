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

    // Monitor canvas context loss
    const checkCanvas = () => {
      const canvases = document.querySelectorAll('canvas')
      canvases.forEach((canvas, i) => {
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
        if (gl) {
          canvas.addEventListener('webglcontextlost', (e) => {
            console.log('[Canvas] WebGL CONTEXT LOST!', i, e)
          })
          console.log('[Canvas] Monitoring WebGL canvas', i)
        }
      })
    }

    // Check after TLDraw creates canvases
    setTimeout(checkCanvas, 1000)

    return () => console.log('[Canvas] UNMOUNTING!')
  }, [])

  // Absolute minimal - no props
  return <Tldraw />
}
