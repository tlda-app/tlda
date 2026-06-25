/**
 * ScreenshotCapture — transient CanvasClipPanel that appears when an agent
 * requests a screenshot. Renders the target region, captures an image from
 * the panel's internal editor, sends it back via Yjs signal, then fades out.
 *
 * Reuses the RefViewer visual style (same panel chrome, Go/dismiss buttons).
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import type { Editor, TLAnyShapeUtilConstructor, TLStateNodeConstructor } from 'tldraw'
import { CanvasClipPanel, type ClipBounds } from '../CanvasClipPanel'
import { writeSignal } from '../useYjsSync'
import type { ScreenshotCaptureState } from '../hooks/useYjsSignals'
interface ScreenshotCaptureProps {
  mainEditor: Editor
  capture: ScreenshotCaptureState
  shapeUtils: TLAnyShapeUtilConstructor[]
  tools: TLStateNodeConstructor[]
  licenseKey: string
  onClose: () => void
}

export function ScreenshotCapture({
  mainEditor, capture, shapeUtils, tools, licenseKey, onClose,
}: ScreenshotCaptureProps) {
  const [panelEditor, setPanelEditor] = useState<Editor | null>(null)
  const capturedRef = useRef(false)
  const [fading, setFading] = useState(false)

  const bounds: ClipBounds = capture.bounds

  const handleEditorMount = useCallback((ed: Editor | null) => {
    setPanelEditor(ed)
  }, [])

  // Once the panel editor mounts and renders, capture the image
  useEffect(() => {
    if (!panelEditor || capturedRef.current) return
    capturedRef.current = true

    const doCapture = async () => {
      // Wait for render to settle
      await new Promise(r => setTimeout(r, 800))

      try {
        const vp = panelEditor.getViewportPageBounds()
        const result = await panelEditor.toImage([], {
          bounds: vp,
          background: true,
          scale: 1,
          pixelRatio: 1,
        })
        const buf = await result.blob.arrayBuffer()
        const reader = new FileReader()
        const base64 = await new Promise<string>((resolve) => {
          reader.onload = () => resolve((reader.result as string).split(',')[1])
          reader.readAsDataURL(new Blob([buf], { type: 'image/png' }))
        })
        writeSignal('signal:screenshot', { data: base64, mimeType: 'image/png' })
        console.log(`[ScreenshotCapture] Captured ${Math.round(base64.length / 1024)}KB`)

        // Broadcast bounds so chat can show annotation viewer for this screenshot
        writeSignal('signal:screenshot-bounds', {
          bounds: capture.bounds,
          agent: capture.agent,
          timestamp: Date.now(),
        })
      } catch (e) {
        console.warn('[ScreenshotCapture] Capture failed:', e)
      }

      // Fade out after capture
      setTimeout(() => setFading(true), 2000)
      setTimeout(() => onClose(), 2500)
    }

    doCapture()
  }, [panelEditor, onClose])

  return (
    <div
      className={`screenshot-capture-overlay${fading ? ' fading' : ''}`}
      style={{
        position: 'fixed',
        bottom: 20,
        left: 20,
        zIndex: 9999,
        opacity: fading ? 0 : 1,
        transition: 'opacity 0.5s ease-out',
        pointerEvents: 'auto',
      }}
    >
      <CanvasClipPanel
        mainEditor={mainEditor}
        bounds={bounds}
        shapeUtils={shapeUtils}
        tools={tools}
        licenseKey={licenseKey}
        panelWidth={400}
        requestedShapeIds={capture.shapeIds}
        requestedShapeTypes={capture.shapeTypes}
        onEditorMount={handleEditorMount}
      />
    </div>
  )
}
