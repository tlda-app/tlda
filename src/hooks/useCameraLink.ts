import { useState, useEffect, useRef, useCallback } from 'react'
import { onCameraLink } from '../useYjsSync'
import type { Editor } from 'tldraw'

function isInputFocused() {
  const tag = window.document.activeElement?.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || (window.document.activeElement as HTMLElement)?.isContentEditable
}

export function useCameraLink(editorRef: React.MutableRefObject<Editor | null>) {
  const [cameraLinked, setCameraLinked] = useState(false)
  const cameraLinkedRef = useRef(false)
  const suppressBroadcastRef = useRef(false)
  const broadcastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { cameraLinkedRef.current = cameraLinked }, [cameraLinked])

  const toggleCameraLink = useCallback(() => {
    setCameraLinked(prev => !prev)
  }, [])

  // Incoming camera link: apply remote camera position
  useEffect(() => {
    return onCameraLink((signal) => {
      const editor = editorRef.current
      if (!editor || !cameraLinkedRef.current) return
      suppressBroadcastRef.current = true
      editor.setCamera({ x: signal.x, y: signal.y, z: signal.z }, { animation: { duration: 80 } })
      setTimeout(() => { suppressBroadcastRef.current = false }, 100)
    })
  }, [])

  // Keyboard shortcut: 'l' for camera link toggle
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'l' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (isInputFocused()) return
        const editor = editorRef.current
        if (!editor) return
        if (editor.getEditingShapeId()) return
        toggleCameraLink()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [toggleCameraLink])

  return { cameraLinked, setCameraLinked, cameraLinkedRef, suppressBroadcastRef, broadcastTimerRef, toggleCameraLink }
}
