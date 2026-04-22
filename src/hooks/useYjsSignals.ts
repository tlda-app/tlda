import { useEffect, useRef } from 'react'
import { createShapeId } from 'tldraw'
import type { Editor } from 'tldraw'
import { onReloadSignal, onForwardSync, onScreenshotRequest, onScreenshotBounds, onRefViewerSignal, isSignalConnected, writeSignal } from '../useYjsSync'
import type { ForwardSyncSignal } from '../useYjsSync'
import { clearLookupCache, loadLookup } from '../synctexLookup'
import type { LookupData } from '../synctexLookup'
import { reloadPages } from '../editorSetup'
import type { ReloadResult } from '../editorSetup'
import type { SvgDocument, DiffData, LabelRegion } from '../svgDocumentLoader'
import { PDF_HEIGHT } from '../layoutConstants'

// SyncTeX y=0 is at the TeX reference point, 72pt from the top of the page
const SYNCTEX_VIEWBOX_OFFSET = 72

function _extractLabel(content: string | undefined): string | null {
  if (!content) return null
  const m = content.match(/\\label\{([^}]+)\}/)
  return m ? m[1] : null
}

/** Find the label nearest to targetY (canvas coords) that appears in the lookup. */
function _nearestLabel(
  lines: LookupData['lines'],
  pages: SvgDocument['pages'],
  targetY: number,
): { label: string; canvasY: number } | null {
  let bestLabel: string | null = null
  let bestCanvasY = 0
  let bestDist = Infinity
  for (const entry of Object.values(lines)) {
    const label = _extractLabel(entry.content)
    if (!label) continue
    const pg = pages[entry.page - 1]
    if (!pg) continue
    const scaleY = pg.bounds.height / PDF_HEIGHT
    const canvasY = pg.bounds.y + (entry.y + SYNCTEX_VIEWBOX_OFFSET) * scaleY
    const dist = Math.abs(canvasY - targetY)
    if (dist < bestDist) { bestDist = dist; bestLabel = label; bestCanvasY = canvasY }
  }
  return bestLabel ? { label: bestLabel, canvasY: bestCanvasY } : null
}

/**
 * Scroll so that `anchorLabel` appears at the same position relative to
 * the viewport center as it did before the rebuild (delta = pre-rebuild
 * labelCanvasY − vpCenterY; positive = label was below center).
 */
function _applyScrollAnchor(
  editor: Editor,
  pages: SvgDocument['pages'],
  newLines: LookupData['lines'],
  anchorLabel: string,
  anchorDelta: number,
) {
  // Build label → entry map
  const labelMap = new Map<string, { page: number; y: number }>()
  for (const entry of Object.values(newLines)) {
    const label = _extractLabel(entry.content)
    if (label) labelMap.set(label, entry)
  }
  const entry = labelMap.get(anchorLabel)
  if (!entry) return
  const pg = pages[entry.page - 1]
  if (!pg) return
  const scaleY = pg.bounds.height / PDF_HEIGHT
  const newLabelCanvasY = pg.bounds.y + (entry.y + SYNCTEX_VIEWBOX_OFFSET) * scaleY
  const targetCenterY = newLabelCanvasY - anchorDelta
  const vp = editor.getViewportPageBounds()
  editor.centerOnPoint({ x: vp.x + vp.w / 2, y: targetCenterY }, { animation: { duration: 200 } })
}

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

      // Snapshot scroll anchor before the rebuild using the pre-reload lookup.
      // delta = labelCanvasY − vpCenterY (positive = label is below center).
      let anchorLabel: string | null = null
      let anchorDelta = 0
      const preLookup = lookupSnapshotRef.current
      if (preLookup && document.pages.length > 0) {
        const vp = editor.getViewportPageBounds()
        const vpCenterY = vp.y + vp.h / 2
        const match = _nearestLabel(preLookup.lines, document.pages, vpCenterY)
        if (match) { anchorLabel = match.label; anchorDelta = match.canvasY - vpCenterY }
      }

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
        reloadPages(editor, document, null).then(async result => {
          onReloadResult?.(result)
          // Fetch refreshed lookup and restore scroll position
          const newLookup = await loadLookup(document.name)
          lookupSnapshotRef.current = newLookup
          if (anchorLabel && newLookup) {
            _applyScrollAnchor(editor, document.pages, newLookup.lines, anchorLabel, anchorDelta)
          }
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

        // All screenshots go through CanvasClipPanel — no direct editor.toImage().
        // ScreenshotCapture handles rendering, capturing, and sending signal:screenshot
        // + signal:screenshot-bounds so the annotation viewer appears in chat.
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
