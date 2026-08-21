import { useEffect, useRef } from 'react'
import { createShapeId, type Editor, type TLShape, type TLShapeId } from 'tldraw'
import { onProjectPartsChangedSignal, onForwardSync, onScreenshotRequest, onScreenshotBounds, isSignalConnected, readSignal, writeSignal } from '../useYjsSync'
import type { ForwardSyncSignal } from '../useYjsSync'
import { clearLookupCache, loadLookup } from '../synctexLookup'
import * as sourceMap from '../sourceMap'
import type { LookupData } from '../synctexLookup'
import { reloadPages } from '../editorSetup'
import type { ReloadResult } from '../editorSetup'
import type { SvgDocument } from '../svgDocumentLoader'
import { getPageRenderHash, getSvgText } from '../stores'
import { createDocVersionReloadObserver, docVersionHashFromRecord, hasRenderedPageMismatch } from './docVersionReload'
// @ts-ignore — vanilla JS module
import { getDeviceId, getHumanId, whenDeviceReady } from '../fleet/fleet-data.mjs'
import {
  dispatchManagedAnnotationViewerHide,
  dispatchManagedAnnotationViewerRequest,
} from '../wm/annotation-viewer-surface'
import { HTML_PAGE_FORMATS } from '../../shared/document-formats.mjs'

type ProjectPartMarkdownShape = TLShape & {
  props: TLShape['props'] & { url?: string }
  meta: TLShape['meta'] & {
    temporaryMarkdownColumn?: boolean
    materializedDoc?: string
    materializedFile?: string
  }
}

function isProjectPartMarkdownShape(shape: TLShape | undefined): shape is ProjectPartMarkdownShape {
  return !!shape?.meta?.temporaryMarkdownColumn
}

function withCacheBust(rawUrl: string, timestamp: number) {
  try {
    const url = new URL(rawUrl, window.location.origin)
    url.searchParams.set('t', String(timestamp))
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    const [baseAndSearch, hash = ''] = rawUrl.split('#')
    const [base, search = ''] = baseAndSearch.split('?')
    const params = new URLSearchParams(search)
    params.set('t', String(timestamp))
    return `${base}?${params.toString()}${hash ? `#${hash}` : ''}`
  }
}

export interface ScreenshotCaptureState {
  bounds: { x: number; y: number; w: number; h: number }
  agent?: string
  timestamp: number
  /** When set, the capture's side editor renders ONLY shapes whose id is in this
   *  list or whose type is in shapeTypes — everything else (incl. the doc pages)
   *  is skipped. Lets an agent capture just the fleet chat without re-rendering
   *  the heavy svg-page shapes. */
  shapeIds?: string[]
  shapeTypes?: string[]
}

interface UseYjsSignalsParams {
  editorRef: React.MutableRefObject<Editor | null>
  editorMounted: number
  document: SvgDocument
  proofDataRef: React.MutableRefObject<any>
  setProofDataReady: (ready: boolean) => void
  setProofFetchSeq: React.Dispatch<React.SetStateAction<number>>
  panelsLocalRef: React.MutableRefObject<boolean>
  onReloadResult?: (result: ReloadResult | null) => void
  onReloadError?: (message: string) => void
  setScreenshotCapture?: (state: ScreenshotCaptureState | null) => void
}

export function useYjsSignals({
  editorRef, editorMounted, document,
  proofDataRef, setProofDataReady, setProofFetchSeq,
  panelsLocalRef: _panelsLocalRef,
  onReloadResult, onReloadError, setScreenshotCapture,
}: UseYjsSignalsParams) {
  const hasSynctex = !HTML_PAGE_FORMATS.has(document.format || '') && !['png', 'slides'].includes(document.format || '')

  // Keep a snapshot of the current lookup for scroll anchoring across rebuilds.
  // The signalBus fires synctexLookup's cache-clear listener before ours, so we
  // can't call loadLookup() inside the reload handler to get pre-rebuild data —
  // the cache is already gone. Instead we pre-load it here and stash it in a ref.
  const lookupSnapshotRef = useRef<LookupData | null>(null)
  useEffect(() => {
    if (!hasSynctex) {
      lookupSnapshotRef.current = null
      return
    }
    loadLookup(document.name).then(data => { lookupSnapshotRef.current = data })
  }, [hasSynctex, document.name])

  const runFullDocumentReload = (editor: Editor) => {
    clearLookupCache(document.name)
    sourceMap.clear()
    if (hasSynctex) sourceMap.load(document.name)
    proofDataRef.current = null
    setProofDataReady(false)
    setProofFetchSeq(s => s + 1)
    reloadPages(editor, document, null).then(async result => {
      onReloadResult?.(result)
      lookupSnapshotRef.current = hasSynctex ? await loadLookup(document.name) : null
    }).catch((e) => {
      const message = e instanceof Error ? e.message : String(e)
      onReloadError?.(`The document changed, but the viewer could not reload it: ${message}`)
    })
  }

  // The doc-version sentinel is durable Yjs state. When it advances past the
  // build hash of already-rendered page text, swap the render through the same
  // reload path the old transient signal used.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || editorMounted === 0) return
    const observer = createDocVersionReloadObserver({
      readHash: () => docVersionHashFromRecord(editor.store.get('shape:doc-version--sentinel' as TLShapeId)),
      hasMismatchedRender: hash => {
        if (document.format === 'slides' || HTML_PAGE_FORMATS.has(document.format || '')) return true
        return hasRenderedPageMismatch(document.pages, hash, getSvgText, getPageRenderHash)
      },
      reload: () => runFullDocumentReload(editor),
    })
    return editor.store.listen(observer, { source: 'remote', scope: 'all' })
  }, [editorMounted, document, hasSynctex])

  // Refresh only the pinned/shared markdown popup whose materialized part
  // actually changed. This avoids the old flicker bug from refreshing the
  // singleton popup on every project reload or poll fallback.
  useEffect(() => {
    return onProjectPartsChangedSignal((signal) => {
      const editor = editorRef.current
      if (!editor || !Array.isArray(signal.files) || signal.files.length === 0) return
      const shapes = editor.getCurrentPageShapes().filter(isProjectPartMarkdownShape)
      for (const shape of shapes) {
        if (shape.meta.materializedDoc !== document.name) continue
        const materializedFile = shape.meta.materializedFile
        if (typeof materializedFile !== 'string' || !signal.files.includes(materializedFile)) continue
        const currentUrl = shape.props?.url
        if (typeof currentUrl !== 'string' || !currentUrl) continue
        const nextUrl = withCacheBust(currentUrl, signal.timestamp || Date.now())
        if (nextUrl === currentUrl) continue
        const wasLocked = !!shape.isLocked
        if (wasLocked) editor.updateShape({ id: shape.id, type: shape.type, isLocked: false } as unknown as Parameters<Editor['updateShape']>[0])
        editor.updateShape({
          id: shape.id,
          type: shape.type,
          props: { ...shape.props, url: nextUrl },
          meta: { ...shape.meta, updatedAt: Date.now() },
        } as unknown as Parameters<Editor['updateShape']>[0])
        if (wasLocked) editor.updateShape({ id: shape.id, type: shape.type, isLocked: true } as unknown as Parameters<Editor['updateShape']>[0])
      }
    })
  }, [document.name])

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
        const reqIds: string[] = Array.isArray(signal.shapeIds) ? signal.shapeIds : []
        const reqTypes: string[] = Array.isArray(signal.shapeTypes) ? signal.shapeTypes : []
        const hasShapeRequest = reqIds.length > 0 || reqTypes.length > 0

        // Determine capture bounds: explicit bounds > page > requested shapes > viewport
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
        } else if (hasShapeRequest) {
          // Frame the requested shapes: union of their page bounds.
          const idSet = new Set(reqIds)
          const typeSet = new Set(reqTypes)
          const matching = editor.getCurrentPageShapes()
            .filter((s: any) => idSet.has(s.id) || typeSet.has(s.type))
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
          for (const s of matching) {
            const b = editor.getShapePageBounds(s.id)
            if (!b) continue
            minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY)
            maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY)
          }
          if (minX !== Infinity) {
            const pad = signal.padding ?? 40
            captureBounds = { x: minX - pad, y: minY - pad, w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 }
          }
        }
        if (!captureBounds) {
          const vp = editor.getViewportPageBounds()
          captureBounds = { x: vp.x, y: vp.y, w: vp.w, h: vp.h }
        }

        if (setScreenshotCapture) {
          setScreenshotCapture({
            bounds: captureBounds,
            agent: signal.agent,
            timestamp: Date.now(),
            shapeIds: reqIds.length ? reqIds : undefined,
            shapeTypes: reqTypes.length ? reqTypes : undefined,
          })
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

      // Follow the scroller that actually contains the placeholder.
      //
      // This used to bind to `document.querySelector('.fleet-chat-log')` — the
      // first one in the document, which is not a rule anyone chose. With more
      // than one chat panel open it is usually not the panel holding the
      // placeholder, so scrolling the panel you are looking at moved nothing and
      // scrolling an unrelated one recomputed a position that had not changed.
      // The class also names two different scrollers with two different scroll
      // implementations — see docs/chat-rendering.md §"Two surfaces share the
      // class name" — so the first match could be the index page's log, which
      // cannot contain a placeholder at all.
      //
      // The placeholder's own ancestor chain is the answer, and it needs no
      // reasoning about layers: whichever copy of the panel is mounted is the
      // one the placeholder is in.
      let boundLog: Element | null = null
      const onScroll = () => { void showAtPlaceholder() }
      function followPlaceholderScroller(placeholder: HTMLElement) {
        const log = placeholder.closest('.fleet-chat-log')
        if (log === boundLog) return
        scrollCleanup?.()
        scrollCleanup = null
        boundLog = log
        if (!log) return
        log.addEventListener('scroll', onScroll, { passive: true })
        scrollCleanup = () => log.removeEventListener('scroll', onScroll)
      }

      async function showAtPlaceholder() {
        await whenDeviceReady()
        // Find the most recent screenshot placeholder in any chat
        const placeholder = window.document.querySelector('.screenshot-placeholder') as HTMLElement | null
        if (!placeholder) {
          // No placeholder visible — do not surface anything in Skip's viewer.
          // The agent gets the screenshot in their own chat; no floating panel here.
          return
        }
        followPlaceholderScroller(placeholder)
        const rect = placeholder.getBoundingClientRect()
        // Only show if placeholder is visible
        if (rect.bottom < 0 || rect.top > window.innerHeight) {
          dispatchManagedAnnotationViewerHide()
          return
        }
        const userId = getHumanId()
        const deviceId = getDeviceId()
        if (!userId || !deviceId) return
        dispatchManagedAnnotationViewerRequest({
          surfaceKey: `screenshot-bounds:${signal.agent || 'agent'}:${signal.timestamp || Date.now()}`,
          bounds: signal.bounds,
          shapeIds: [],
          label,
          pinned: true,
          chipRect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
          owner: { userId, deviceId },
          source: `screenshot-bounds:${signal.agent || 'agent'}:${signal.timestamp || 'unknown'}`,
          viewport: { w: window.innerWidth, h: window.innerHeight },
        })
      }

      showAtPlaceholder()
    })

    return () => {
      unsub()
      scrollCleanup?.()
    }
  }, [])

}
