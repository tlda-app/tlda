import { useEffect, useRef, useCallback } from 'react'
import { onCameraLink } from '../useYjsSync'
import { getRole, subscribeRole } from '../viewerRole'
import type { Editor } from 'tldraw'

export function useCameraLink(editorRef: React.MutableRefObject<Editor | null>) {
  const suppressBroadcastRef = useRef(false)
  const broadcastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Incoming camera signal: apply only when viewer
  useEffect(() => {
    return onCameraLink((signal) => {
      const editor = editorRef.current
      if (!editor || getRole() !== 'viewer') return
      suppressBroadcastRef.current = true
      editor.setCamera({ x: signal.x, y: signal.y, z: signal.z }, { animation: { duration: 80 } })
      setTimeout(() => { suppressBroadcastRef.current = false }, 100)
    })
  }, [])

  return { suppressBroadcastRef, broadcastTimerRef }
}
