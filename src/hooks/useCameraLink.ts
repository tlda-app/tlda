import { useEffect, useRef } from 'react'
import { onCameraLink } from '../useYjsSync'
import { getRole } from '../viewerRole'
import type { Editor } from 'tldraw'

export function useCameraLink(editorRef: React.MutableRefObject<Editor | null>, isPresentation: boolean) {
  const suppressBroadcastRef = useRef(false)
  const broadcastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return onCameraLink((signal) => {
      const editor = editorRef.current
      if (!editor) return
      // Presentation: only viewers follow. Peer-to-peer: everyone syncs.
      if (isPresentation && getRole() !== 'viewer') return
      suppressBroadcastRef.current = true
      editor.setCamera({ x: signal.x, y: signal.y, z: signal.z }, { animation: { duration: 80 } })
      setTimeout(() => { suppressBroadcastRef.current = false }, 100)
    })
  }, [isPresentation])

  return { suppressBroadcastRef, broadcastTimerRef }
}
