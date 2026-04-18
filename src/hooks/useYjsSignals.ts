import { useEffect } from 'react'
import { createShapeId } from 'tldraw'
import type { Editor } from 'tldraw'
import { onReloadSignal, onForwardSync, onScreenshotRequest, onScreenshotBounds, onRefViewerSignal, isSignalConnected, writeSignal } from '../useYjsSync'
import type { ForwardSyncSignal } from '../useYjsSync'
import { clearLookupCache } from '../synctexLookup'
import { reloadPages } from '../editorSetup'
import type { ReloadResult } from '../editorSetup'
import type { SvgDocument, DiffData, LabelRegion } from '../svgDocumentLoader'

export interface ScreenshotCaptureState {
  bounds: { x: number; y: number; w: number; h: number }
  agent?: string
  timestamp: number
}

interface UseYjsSignalsParams {
  editorRef: React.MutableRefObject<Editor | null>
  document: SvgDocument
  diffDataRef: React.MutableRefObject<DiffData | null>
  setDiffFetchSeq: React.Dispatch<React.SetStateAction<number>>
  proofDataRef: React.MutableRefObject<any>
  setProofDataReady: (ready: boolean) => void
  setProofFetchSeq: React.Dispatch<React.SetStateAction<number>>
  setRefViewerRefs: (refs: { label: string; region: LabelRegion }[] | null) => void
  refViewerLineRef: React.MutableRefObject<number | null>
  panelsLocalRef: React.MutableRefObject<boolean>
  onReloadResult?: (result: ReloadResult | null) => void
  setScreenshotCapture?: (state: ScreenshotCaptureState | null) => void
}

export function useYjsSignals({
  editorRef, document,
  diffDataRef, setDiffFetchSeq,
  proofDataRef, setProofDataReady, setProofFetchSeq,
  setRefViewerRefs, refViewerLineRef, panelsLocalRef,
  onReloadResult, setScreenshotCapture,
}: UseYjsSignalsParams) {
  // Subscribe to Yjs reload signals
  useEffect(() => {
    return onReloadSignal((signal) => {
      const editor = editorRef.current
      if (!editor) return
      if (signal.type === 'partial') {
        reloadPages(editor, document, signal.pages).then(result => {
          onReloadResult?.(result)
        })
      } else {
        clearLookupCache(document.name)
        diffDataRef.current = null
        setDiffFetchSeq(s => s + 1)
        proofDataRef.current = null
        setProofDataReady(false)
        setProofFetchSeq(s => s + 1)
        reloadPages(editor, document, null).then(result => {
          onReloadResult?.(result)
        })
      }
    })
  }, [document])

  // Subscribe to Yjs forward sync signals (scroll, highlight from Claude)
  useEffect(() => {
    return onForwardSync((signal: ForwardSyncSignal) => {
      const editor = editorRef.current
      if (!editor) return

      function pageCenterX(canvasY: number): number {
        for (const page of document.pages) {
          if (canvasY >= page.bounds.y && canvasY <= page.bounds.y + page.bounds.h) {
            return page.bounds.x + page.bounds.w / 2
          }
        }
        return document.pages.length > 0
          ? document.pages[0].bounds.x + document.pages[0].bounds.w / 2
          : 400
      }

      if (signal.type === 'scroll') {
        editor.centerOnPoint({ x: pageCenterX(signal.y), y: signal.y }, { animation: { duration: 300 } })
      }

      if (signal.type === 'scroll-to-element') {
        // For HTML/markdown docs: find the iframe and postMessage to scroll to element by ID
        const { id: elementId } = signal as any
        if (elementId) {
          // Find all html-page iframes and send the scroll command
          const iframes = window.document.querySelectorAll('iframe[src*="_tldaShape"]') as NodeListOf<HTMLIFrameElement>
          for (const iframe of iframes) {
            if (iframe.contentWindow) {
              iframe.contentWindow.postMessage({ type: 'tlda-scroll-to-id', id: elementId }, '*')
            }
          }
        }
      }

      if (signal.type === 'set-chat-target') {
        const { agent, panel, chatShapeId } = signal as any
        // Find fleet-chat shapes and update the filter
        const chatShapes = Object.values(editor.store.allRecords())
          .filter((r: any) => r.typeName === 'shape' && r.type === 'fleet-chat') as any[]
        if (chatShapes.length === 0) return
        let target: any
        if (chatShapeId) {
          // Exact shape ID — use the chat the user is talking in
          target = chatShapes.find((s: any) => s.id === chatShapeId)
        } else if (panel === 'left' || panel === 'right') {
          const sorted = [...chatShapes].sort((a, b) => a.x - b.x)
          target = panel === 'left' ? sorted[0] : sorted[sorted.length - 1]
        } else {
          target = chatShapes.sort((a: any, b: any) => a.x - b.x)[0]
        }
        if (target) {
          const newFilter = agent ? [[['to', agent]]] : []
          editor.store.update(target.id, (s: any) => ({
            ...s,
            props: { ...s.props, filter: newFilter },
          }))
        }
      }

      if (signal.type === 'highlight') {
        editor.centerOnPoint({ x: pageCenterX(signal.y), y: signal.y }, { animation: { duration: 300 } })
        const markerId = createShapeId()
        editor.createShape({
          id: markerId,
          type: 'geo',
          x: signal.x - 30,
          y: signal.y - 30,
          props: { geo: 'ellipse', w: 60, h: 60, fill: 'none', color: 'red', size: 'm' },
        })
        setTimeout(() => {
          if (editor.getShape(markerId)) editor.deleteShape(markerId)
        }, 3000)
      }
    })
  }, [document])

  // Handle screenshot requests from MCP
  useEffect(() => {
    // Track last user interaction to prioritize active viewers for screenshots
    let lastInteraction = Date.now()
    const onInteract = () => { lastInteraction = Date.now() }
    window.addEventListener('pointerdown', onInteract, true)
    window.addEventListener('keydown', onInteract, true)

    const unsub = onScreenshotRequest(async (signal: any) => {
      const editor = editorRef.current
      if (!editor || !isSignalConnected()) return
      // Delay based on staleness: recently active viewers respond first (0-2s)
      const staleness = Math.min((Date.now() - lastInteraction) / 30000, 1)
      const delay = Math.round(staleness * 2000)
      if (delay > 0) await new Promise(r => setTimeout(r, delay))
      try {
        // Determine capture bounds: explicit bounds > page > viewport
        let captureBounds: { x: number; y: number; w: number; h: number } | null = null
        if (signal.bounds) {
          captureBounds = { x: signal.bounds.x, y: signal.bounds.y, w: signal.bounds.w, h: signal.bounds.h }
        } else if (signal.page) {
          const pageShapes = editor.getCurrentPageShapes().filter((s: any) => s.type === 'svg-page')
          const sorted = [...pageShapes].sort((a: any, b: any) => a.y - b.y)
          const target = sorted[signal.page - 1]
          if (target) {
            const b = editor.getShapePageBounds(target.id)
            if (b) captureBounds = { x: b.x, y: b.y, w: b.w, h: b.h }
          }
        }
        if (!captureBounds) {
          const vp = editor.getViewportPageBounds()
          captureBounds = { x: vp.x, y: vp.y, w: vp.w, h: vp.h }
        }

        if (signal.bounds || signal.page) {
          // Targeted screenshot: render via CanvasClipPanel (handles off-screen content).
          // The ScreenshotCapture component handles rendering, capturing, and sending
          // the signal:screenshot response.
          if (setScreenshotCapture) {
            setScreenshotCapture({ bounds: captureBounds, agent: signal.agent, timestamp: Date.now() })
          }
          return
        }

        // Viewport screenshot (no bounds/page specified): capture current view directly
        const vp = editor.getViewportPageBounds()
        const { blob } = await editor.toImage([], {
          bounds: vp,
          background: true,
          scale: 1,
          pixelRatio: 1,
        })
        const buf = await blob.arrayBuffer()
        const reader = new FileReader()
        const base64 = await new Promise<string>((resolve) => {
          reader.onload = () => {
            const result = reader.result as string
            resolve(result.split(',')[1])
          }
          reader.readAsDataURL(new Blob([buf], { type: 'image/png' }))
        })
        writeSignal('signal:screenshot', { data: base64, mimeType: 'image/png' })
        console.log(`[Screenshot] Captured viewport (${Math.round(base64.length / 1024)}KB)`)
      } catch (e) {
        console.warn('[Screenshot] Capture failed:', e)
      }
    })
    return () => {
      unsub()
      window.removeEventListener('pointerdown', onInteract, true)
      window.removeEventListener('keydown', onInteract, true)
    }
  }, [])

  // Screenshot bounds: auto-show annotation viewer over the chat placeholder
  useEffect(() => {
    let scrollCleanup: (() => void) | null = null

    const unsub = onScreenshotBounds((signal: any) => {
      if (!signal.bounds) return
      const label = signal.agent ? `📷 ${signal.agent}` : '📷 screenshot'

      function showAtPlaceholder() {
        // Find the most recent screenshot placeholder in any chat
        const placeholder = document.querySelector('.screenshot-placeholder') as HTMLElement | null
        if (!placeholder) {
          // No placeholder visible — show as floating panel
          window.dispatchEvent(new CustomEvent('annotation-viewer-show', {
            detail: { bounds: signal.bounds, shapeIds: [], label, pinned: true }
          }))
          return
        }
        const rect = placeholder.getBoundingClientRect()
        // Only show if placeholder is visible
        if (rect.bottom < 0 || rect.top > window.innerHeight) {
          window.dispatchEvent(new CustomEvent('annotation-viewer-hide'))
          return
        }
        window.dispatchEvent(new CustomEvent('annotation-viewer-show', {
          detail: {
            bounds: signal.bounds,
            shapeIds: [],
            label,
            pinned: true,
            chipRect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
          }
        }))
      }

      showAtPlaceholder()

      // Track scroll in the chat log to move the overlay
      const chatLog = document.querySelector('.fleet-chat-log')
      if (chatLog) {
        const onScroll = () => showAtPlaceholder()
        chatLog.addEventListener('scroll', onScroll, { passive: true })
        scrollCleanup = () => chatLog.removeEventListener('scroll', onScroll)
      }
    })

    return () => {
      unsub()
      scrollCleanup?.()
    }
  }, [])

  // Incoming ref viewer signal: show refs from another viewer
  useEffect(() => {
    return onRefViewerSignal((signal) => {
      if (!panelsLocalRef.current) return
      if (signal.refs === null) {
        setRefViewerRefs(null)
        refViewerLineRef.current = null
      } else {
        setRefViewerRefs(signal.refs as any)
      }
    })
  }, [])
}
