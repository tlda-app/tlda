import { useEffect, useRef } from 'react'
import { createShapeId } from 'tldraw'
import type { Editor } from 'tldraw'
import { onReloadSignal, onSourceChangedSignal, onForwardSync, onScreenshotRequest, onScreenshotBounds, isSignalConnected, readSignal, writeSignal } from '../useYjsSync'
import type { ForwardSyncSignal } from '../useYjsSync'
import { clearLookupCache, loadLookup } from '../synctexLookup'
import * as sourceMap from '../sourceMap'
import type { LookupData } from '../synctexLookup'
import { reloadPages } from '../editorSetup'
import type { ReloadResult } from '../editorSetup'
import type { SvgDocument, DiffData } from '../svgDocumentLoader'

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
  panelsLocalRef: React.MutableRefObject<boolean>
  onReloadResult?: (result: ReloadResult | null) => void
  setScreenshotCapture?: (state: ScreenshotCaptureState | null) => void
}

export function useYjsSignals({
  editorRef, document,
  diffDataRef, setDiffFetchSeq,
  proofDataRef, setProofDataReady, setProofFetchSeq,
  panelsLocalRef: _panelsLocalRef,
  onReloadResult, setScreenshotCapture,
}: UseYjsSignalsParams) {
  // Keep a snapshot of the current lookup for scroll anchoring across rebuilds.
  // The signalBus fires synctexLookup's cache-clear listener before ours, so we
  // can't call loadLookup() inside the reload handler to get pre-rebuild data —
  // the cache is already gone. Instead we pre-load it here and stash it in a ref.
  const lookupSnapshotRef = useRef<LookupData | null>(null)
  useEffect(() => {
    loadLookup(document.name).then(data => { lookupSnapshotRef.current = data })
  }, [document.name])

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
        sourceMap.clear()
        sourceMap.load(document.name)
        diffDataRef.current = null
        setDiffFetchSeq(s => s + 1)
        proofDataRef.current = null
        setProofDataReady(false)
        setProofFetchSeq(s => s + 1)
        reloadPages(editor, document, null).then(async result => {
          onReloadResult?.(result)
          // Refresh lookup cache for future synctex queries
          lookupSnapshotRef.current = await loadLookup(document.name)
        })
      }
    })
  }, [document])

  // Re-fetch visible pages when source files change — triggers the ensure system
  // which rebuilds if source.stamp > build.stamp. The build then sends signal:reload.
  useEffect(() => {
    return onSourceChangedSignal(() => {
      const editor = editorRef.current
      if (!editor) return
      reloadPages(editor, document, null)
    })
  }, [document])

  // Poll for new builds as a fallback — catches stale content if the reload signal
  // was missed (e.g. tldraw sync WebSocket died silently after a server restart).
  useEffect(() => {
    const docName = document.name
    let lastKnownBuild = ''
    const poll = async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(docName)}`)
        if (!res.ok) return
        const data = await res.json()
        const buildTs = data.lastBuild || ''
        if (!lastKnownBuild) { lastKnownBuild = buildTs; return }
        if (buildTs && buildTs !== lastKnownBuild) {
          lastKnownBuild = buildTs
          const editor = editorRef.current
          if (editor) {
            console.log(`[Poll] New build detected (${buildTs}), reloading viewport pages`)
            reloadPages(editor, document, null).then(result => onReloadResult?.(result))
          }
        }
      } catch {}
    }
    const timer = setInterval(poll, 30_000)
    poll() // initial check
    return () => clearInterval(timer)
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
          const newFilter = agent ? [[['to', agent]], [['from', agent]]] : []
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

      // Only one viewer should handle each request. After the staleness delay,
      // check if another viewer already claimed this request.
      const reqTs = signal.timestamp || 0
      const claimed = readSignal<{ requestTimestamp: number }>('signal:screenshot-claimed')
      if (claimed && claimed.requestTimestamp === reqTs) return
      writeSignal('signal:screenshot-claimed', { requestTimestamp: reqTs })

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

        if (setScreenshotCapture) {
          setScreenshotCapture({ bounds: captureBounds, agent: signal.agent, timestamp: Date.now() })
        }
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
        const placeholder = window.document.querySelector('.screenshot-placeholder') as HTMLElement | null
        if (!placeholder) {
          // No placeholder visible — do not surface anything in Skip's viewer.
          // The agent gets the screenshot in their own chat; no floating panel here.
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
      const chatLog = window.document.querySelector('.fleet-chat-log')
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

}
