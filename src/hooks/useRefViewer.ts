import { useState, useEffect, useRef, useCallback } from 'react'
import type { Editor } from 'tldraw'
import { broadcastRefViewer, writeSignal } from '../useYjsSync'
import { canvasToPdf } from '../synctexAnchor'
import { buildReverseIndex } from '../synctexLookup'
import { PDF_HEIGHT } from '../layoutConstants'
import type { SvgDocument, ProofData, LabelRegion } from '../svgDocumentLoader'

interface UseRefViewerParams {
  editorRef: React.MutableRefObject<Editor | null>
  document: SvgDocument
  proofDataRef: React.MutableRefObject<ProofData | null>
  proofDataReady: boolean
}

export function useRefViewer({
  editorRef, document, proofDataRef, proofDataReady,
}: UseRefViewerParams) {
  const [refViewerRefs, setRefViewerRefs] = useState<{ label: string; region: LabelRegion }[] | null>(null)
  const refViewerLineRef = useRef<number | null>(null)
  const sortedRefLinesRef = useRef<number[]>([])
  const flatRefsRef = useRef<{ line: number; label: string; region: LabelRegion }[]>([])
  const flatRefIndexRef = useRef<number>(-1)

  // Camera history for "go back" after "go there"
  const cameraHistoryRef = useRef<{x: number, y: number, z: number}[]>([])
  const [canGoBack, setCanGoBack] = useState(false)

  // Broadcast ref viewer state to other viewers when it changes
  const refViewerUserActionRef = useRef(false)
  useEffect(() => {
    if (!refViewerUserActionRef.current) return
    broadcastRefViewer(refViewerRefs)
    refViewerUserActionRef.current = false
  }, [refViewerRefs])

  // Wrapper to set refs from local user actions (triggers broadcast)
  const setRefViewerRefsLocal = useCallback((refs: { label: string; region: LabelRegion }[] | null) => {
    refViewerUserActionRef.current = true
    setRefViewerRefs(refs)
    if (refs === null) {
      refViewerLineRef.current = null
      flatRefIndexRef.current = -1
    }
  }, [])

  // --- Reverse index for click-to-ref ---
  const reverseIndexRef = useRef<((page: number, y: number) => number | null) | null>(null)
  useEffect(() => {
    buildReverseIndex(document.name).then(fn => { reverseIndexRef.current = fn })
  }, [document.name])

  // Helper: resolve refs on a given line to regions
  const resolveRefsOnLine = useCallback((line: number): { label: string; region: LabelRegion }[] | null => {
    const proofData = proofDataRef.current
    if (!proofData) return null
    const lineRefsMap = proofData.lineRefs
    let refsOnLine: string[] | undefined
    let matchedLine = line
    for (let offset = 0; offset <= 5; offset++) {
      if (lineRefsMap[(line + offset).toString()]) {
        refsOnLine = lineRefsMap[(line + offset).toString()]
        matchedLine = line + offset
        break
      }
      if (offset > 0 && lineRefsMap[(line - offset).toString()]) {
        refsOnLine = lineRefsMap[(line - offset).toString()]
        matchedLine = line - offset
        break
      }
    }
    if (!refsOnLine || refsOnLine.length === 0) return null
    const resolved: { label: string; region: LabelRegion }[] = []
    for (const label of refsOnLine) {
      const region = proofData.labelRegions[label]
      if (region) resolved.push({ label, region })
    }
    if (resolved.length === 0) return null
    refViewerLineRef.current = matchedLine
    return resolved
  }, [])

  // Build flat ref list when proof data loads
  useEffect(() => {
    const proofData = proofDataRef.current
    if (!proofData || !proofDataReady) {
      sortedRefLinesRef.current = []
      flatRefsRef.current = []
      return
    }
    const sorted = Object.keys(proofData.lineRefs).map(Number).sort((a, b) => a - b)
    sortedRefLinesRef.current = sorted
    const flat: { line: number; label: string; region: LabelRegion }[] = []
    for (const line of sorted) {
      const labels = proofData.lineRefs[line.toString()]
      if (!labels) continue
      for (const label of labels) {
        const region = proofData.labelRegions[label]
        if (region) flat.push({ line, label, region })
      }
    }
    flatRefsRef.current = flat
  }, [proofDataReady])

  // Navigate to prev/next ref in document (one ref at a time)
  const navigateRef = useCallback((direction: -1 | 1) => {
    const flat = flatRefsRef.current
    if (flat.length === 0) return
    const idx = flatRefIndexRef.current
    const nextIdx = idx + direction
    if (nextIdx < 0 || nextIdx >= flat.length) return
    flatRefIndexRef.current = nextIdx
    const entry = flat[nextIdx]
    refViewerLineRef.current = entry.line
    setRefViewerRefsLocal([{ label: entry.label, region: entry.region }])
  }, [setRefViewerRefsLocal])

  // "Go there" / "Go back"
  const handleGoThere = useCallback((region: LabelRegion) => {
    const editor = editorRef.current
    if (!editor) return
    const cam = editor.getCamera()
    cameraHistoryRef.current.push({ x: cam.x, y: cam.y, z: cam.z })
    setCanGoBack(true)
    const pageIdx = region.page - 1
    const page = document.pages[pageIdx]
    if (!page) return
    const scaleY = page.bounds.height / PDF_HEIGHT
    const canvasY = page.bounds.y + region.yTop * scaleY
    editor.centerOnPoint(
      { x: page.bounds.x + page.bounds.width / 2, y: canvasY },
      { animation: { duration: 300 } }
    )
  }, [document])

  const handleGoBack = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    const history = cameraHistoryRef.current
    if (history.length === 0) return
    const cam = history.pop()!
    setCanGoBack(history.length > 0)
    editor.setCamera(cam, { animation: { duration: 300 } })
  }, [])

  const clearHistory = useCallback(() => {
    cameraHistoryRef.current = []
    setCanGoBack(false)
  }, [])

  // Shared ref lookup from screen coordinates
  const lookupRefAt = useCallback((clientX: number, clientY: number): boolean => {
    const editor = editorRef.current
    if (!editor) return false
    const reverseIndex = reverseIndexRef.current
    if (!reverseIndex) return false

    const point = editor.screenToPage({ x: clientX, y: clientY })
    const pages = document.pages.map(p => ({
      bounds: { x: p.bounds.x, y: p.bounds.y, width: p.bounds.width, height: p.bounds.height },
      width: p.width,
      height: p.height,
    }))
    const pdf = canvasToPdf(point.x, point.y, pages)
    if (!pdf) return false

    const line = reverseIndex(pdf.page, pdf.y)
    if (!line) return false

    const resolved = resolveRefsOnLine(line)
    if (!resolved) return false

    const flat = flatRefsRef.current
    const firstLabel = resolved[0].label
    const flatIdx = flat.findIndex(e => e.label === firstLabel)
    if (flatIdx >= 0) flatRefIndexRef.current = flatIdx
    setRefViewerRefsLocal([resolved[0]])
    return true
  }, [document, resolveRefsOnLine, setRefViewerRefsLocal])

  // Desktop: double-click to look up refs
  // iPad: single finger tap
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !proofDataReady) return
    const container = editor.getContainer()

    const handleDoubleClick = (e: MouseEvent) => {
      const point = editor.screenToPage({ x: e.clientX, y: e.clientY })
      const hitShape = editor.getShapeAtPoint(point, { hitInside: true, margin: 0 })
      if (hitShape && hitShape.type !== 'image' && (hitShape.type as string) !== 'svg-page') return

      if (editor.getCurrentToolId() === 'select') {
        editor.cancel()
      }
      lookupRefAt(e.clientX, e.clientY)
    }

    const TAP_THRESHOLD = 10
    const TAP_TIME = 300
    let tapStart: { x: number; y: number; time: number } | null = null

    const handlePointerDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return
      tapStart = { x: e.clientX, y: e.clientY, time: Date.now() }
    }

    const handlePointerUp = (e: PointerEvent) => {
      if (e.pointerType !== 'touch' || !tapStart) return
      const dx = e.clientX - tapStart.x
      const dy = e.clientY - tapStart.y
      const dt = Date.now() - tapStart.time
      tapStart = null
      if (Math.abs(dx) > TAP_THRESHOLD || Math.abs(dy) > TAP_THRESHOLD || dt > TAP_TIME) return
      lookupRefAt(e.clientX, e.clientY)
    }

    container.addEventListener('dblclick', handleDoubleClick)
    container.addEventListener('pointerdown', handlePointerDown)
    container.addEventListener('pointerup', handlePointerUp)
    return () => {
      container.removeEventListener('dblclick', handleDoubleClick)
      container.removeEventListener('pointerdown', handlePointerDown)
      container.removeEventListener('pointerup', handlePointerUp)
    }
  }, [document, proofDataReady, lookupRefAt])

  // Reverse synctex: cmd+click to jump to source line in editor
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const container = editor.getContainer()

    const handleClick = (e: MouseEvent) => {
      if (!e.metaKey && !e.ctrlKey) return
      const reverseIndex = reverseIndexRef.current
      if (!reverseIndex) return

      const point = editor.screenToPage({ x: e.clientX, y: e.clientY })
      const pages = document.pages.map(p => ({
        bounds: { x: p.bounds.x, y: p.bounds.y, width: p.bounds.width, height: p.bounds.height },
        width: p.width, height: p.height,
      }))
      const pdf = canvasToPdf(point.x, point.y, pages)
      if (!pdf) return

      const line = reverseIndex(pdf.page, pdf.y)
      if (!line) return

      e.preventDefault()
      e.stopPropagation()
      writeSignal('signal:reverse-sync', { line })
    }

    container.addEventListener('click', handleClick)
    return () => container.removeEventListener('click', handleClick)
  }, [document])

  return {
    refViewerRefs, setRefViewerRefs, setRefViewerRefsLocal,
    refViewerLineRef,
    navigateRef, handleGoThere, handleGoBack, canGoBack,
    cameraHistoryRef, clearHistory,
  }
}
