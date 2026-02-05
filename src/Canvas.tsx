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
    return () => console.log('[Canvas] UNMOUNTING!')
  }, [])

  // Absolute minimal - no props
  return <Tldraw />
}
