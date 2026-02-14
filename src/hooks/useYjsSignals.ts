import { useEffect } from 'react'
import { createShapeId } from 'tldraw'
import type { Editor } from 'tldraw'
import { onReloadSignal, onForwardSync, onScreenshotRequest, onRefViewerSignal, getYRecords, writeSignal } from '../useYjsSync'
import type { ForwardSyncSignal } from '../useYjsSync'
import { clearLookupCache } from '../synctexLookup'
import { reloadPages } from '../editorSetup'
import type { SvgDocument, DiffData, LabelRegion } from '../svgDocumentLoader'

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
}

export function useYjsSignals({
  editorRef, document,
  diffDataRef, setDiffFetchSeq,
  proofDataRef, setProofDataReady, setProofFetchSeq,
  setRefViewerRefs, refViewerLineRef, panelsLocalRef,
}: UseYjsSignalsParams) {
  // Subscribe to Yjs reload signals
  useEffect(() => {
    return onReloadSignal((signal) => {
      const editor = editorRef.current
      if (!editor) return
      if (signal.type === 'partial') {
        reloadPages(editor, document, signal.pages)
      } else {
        clearLookupCache(document.name)
        diffDataRef.current = null
        setDiffFetchSeq(s => s + 1)
        proofDataRef.current = null
        setProofDataReady(false)
        setProofFetchSeq(s => s + 1)
        reloadPages(editor, document, null)
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

    const unsub = onScreenshotRequest(async () => {
      const editor = editorRef.current
      const yRecords = getYRecords()
      if (!editor || !yRecords) return
      // Delay based on staleness: recently active viewers respond first (0-2s)
      // This lets the most interactive viewer win the race
      const staleness = Math.min((Date.now() - lastInteraction) / 30000, 1) // 0..1 over 30s
      const delay = Math.round(staleness * 2000)
      if (delay > 0) await new Promise(r => setTimeout(r, delay))
      try {
        const viewportBounds = editor.getViewportPageBounds()
        const { blob } = await editor.toImage([], {
          bounds: viewportBounds,
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
        console.log(`[Screenshot] Captured ${Math.round(base64.length / 1024)}KB`)
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
