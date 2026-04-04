/**
 * useShadowOverlay — manages the shadow history scrubber and canvas overlay.
 *
 * Fetches shadow repo versions (one per successful build) and lets the user
 * scrub through them. When at a historical position, old SVGs are placed as
 * TLDraw shapes to the LEFT of current pages so both versions are visible.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { toRichText } from 'tldraw'
import type { TLShapeId, Editor } from 'tldraw'
import { fetchShadowVersions, shadowSnapshotPageUrl } from '../historyStore'
import type { ShadowVersion } from '../historyStore'
import type { SvgDocument } from '../svgDocumentLoader'
import { TARGET_WIDTH } from '../layoutConstants'
import { setSvgText, deleteSvgText, svgViewBoxStore } from '../stores'

const OLD_PAGE_GAP = 48
const SHADOW_SHAPE_PREFIX = 'shape:shadow-hist-'

interface ShadowOverlayState {
  shapeIds: TLShapeId[]
  hash: string
}

export function useShadowOverlay(
  editorRef: React.MutableRefObject<Editor | null>,
  document: SvgDocument,
  docName: string,
  shapeIdSetRef: React.MutableRefObject<Set<TLShapeId>>,
  shapeIdsArrayRef: React.MutableRefObject<TLShapeId[]>,
  updateCameraBoundsRef: React.MutableRefObject<((bounds: any) => void) | null>,
) {
  const [versions, setVersions] = useState<ShadowVersion[]>([])
  // activeIdx: index into versions (0 = newest). -1 = current (no overlay).
  const [activeIdx, setActiveIdx] = useState(-1)
  const [loading, setLoading] = useState(false)
  const [visible, setVisible] = useState(false)
  const overlayRef = useRef<ShadowOverlayState | null>(null)
  const versionsRef = useRef(versions)
  versionsRef.current = versions

  // Fetch versions — called on mount and on explicit refresh
  const fetchVersions = useCallback(async () => {
    const v = await fetchShadowVersions(docName)
    setVersions(v)
    versionsRef.current = v
    return v
  }, [docName])

  // Pre-fetch on mount so the version count is available immediately
  useEffect(() => {
    fetchVersions()
  }, [fetchVersions])

  // Show the overlay (fetch versions if needed)
  const show = useCallback(async () => {
    let v = versionsRef.current
    if (v.length === 0) {
      v = await fetchVersions()
    }
    setVisible(true)
    // Default to current (rightmost = -1 means latest)
    setActiveIdx(-1)
  }, [fetchVersions])

  // Hide the overlay and clean up canvas shapes
  const hide = useCallback(() => {
    setVisible(false)
    removeOldShapes(editorRef.current, overlayRef, shapeIdSetRef, shapeIdsArrayRef, document)
    // Restore camera bounds
    if (updateCameraBoundsRef.current && document.pages.length > 0) {
      const bounds = document.pages.reduce(
        (acc, page) => acc.union(page.bounds),
        document.pages[0].bounds.clone(),
      )
      updateCameraBoundsRef.current(bounds)
    }
    setActiveIdx(-1)
  }, [editorRef, document, shapeIdSetRef, shapeIdsArrayRef, updateCameraBoundsRef])

  const toggle = useCallback(() => {
    if (visible) hide()
    else show()
  }, [visible, hide, show])

  // When activeIdx changes, update the canvas
  const handleScrub = useCallback(async (idx: number) => {
    const v = versionsRef.current
    setActiveIdx(idx)

    // -1 = current (no overlay)
    if (idx < 0) {
      removeOldShapes(editorRef.current, overlayRef, shapeIdSetRef, shapeIdsArrayRef, document)
      // Restore camera bounds
      if (updateCameraBoundsRef.current && document.pages.length > 0) {
        const bounds = document.pages.reduce(
          (acc, page) => acc.union(page.bounds),
          document.pages[0].bounds.clone(),
        )
        updateCameraBoundsRef.current(bounds)
      }
      return
    }

    const version = v[idx]
    if (!version) return

    const editor = editorRef.current
    if (!editor) return

    setLoading(true)
    try {
      await placeOldPages(
        editor, docName, version.hash, document,
        overlayRef, shapeIdSetRef, shapeIdsArrayRef, updateCameraBoundsRef,
      )
    } finally {
      setLoading(false)
    }
  }, [docName, document, editorRef, shapeIdSetRef, shapeIdsArrayRef, updateCameraBoundsRef])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      removeOldShapes(editorRef.current, overlayRef, shapeIdSetRef, shapeIdsArrayRef, document)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Derived: current version being viewed
  const activeVersion = activeIdx >= 0 && activeIdx < versions.length
    ? versions[activeIdx]
    : null  // null = current

  return {
    shadowVersions: versions,
    shadowActiveIdx: activeIdx,
    shadowLoading: loading,
    shadowVisible: visible,
    shadowActiveVersion: activeVersion,
    showShadowOverlay: show,
    hideShadowOverlay: hide,
    toggleShadowOverlay: toggle,
    handleShadowScrub: handleScrub,
    refreshShadowVersions: fetchVersions,
  }
}

// ── Canvas helpers ──────────────────────────────────────────────────────────

async function placeOldPages(
  editor: Editor,
  docName: string,
  hash: string,
  document: SvgDocument,
  overlayRef: React.MutableRefObject<ShadowOverlayState | null>,
  shapeIdSetRef: React.MutableRefObject<Set<TLShapeId>>,
  shapeIdsArrayRef: React.MutableRefObject<TLShapeId[]>,
  updateCameraBoundsRef: React.MutableRefObject<((bounds: any) => void) | null>,
) {
  // Remove any existing old-page shapes
  removeOldShapes(editor, overlayRef, shapeIdSetRef, shapeIdsArrayRef, document)

  const totalPages = document.pages.length

  // Fetch old SVGs concurrently
  const fetchResults: Array<{
    pageNum: number
    svgText: string
    width: number
    height: number
    viewBox: { minX: number; minY: number; width: number; height: number }
  }> = []

  await Promise.all(
    Array.from({ length: totalPages }, (_, i) => i + 1).map(async (pageNum) => {
      const url = shadowSnapshotPageUrl(docName, hash, pageNum)
      try {
        const resp = await fetch(url)
        if (!resp.ok) return
        const svgText = await resp.text()
        const dims = parseSvgDimensions(svgText)
        fetchResults.push({ pageNum, svgText, ...dims })
      } catch {
        // skip pages that fail to load
      }
    }),
  )

  if (fetchResults.length === 0) return
  fetchResults.sort((a, b) => a.pageNum - b.pageNum)

  const createdIds: TLShapeId[] = []

  editor.store.mergeRemoteChanges(() => {
    for (const op of fetchResults) {
      const currentPage = document.pages[op.pageNum - 1]
      if (!currentPage) continue

      const shapeId = `${SHADOW_SHAPE_PREFIX}${op.pageNum}` as TLShapeId

      // Scale old page to match current page width
      const scale = TARGET_WIDTH / op.width
      const displayW = TARGET_WIDTH
      const displayH = op.height * scale

      // Position to the left of current page
      const oldX = currentPage.bounds.x - displayW - OLD_PAGE_GAP
      const oldY = currentPage.bounds.y

      setSvgText(shapeId, op.svgText)
      svgViewBoxStore.set(shapeId, op.viewBox)

      editor.createShapes([{
        id: shapeId,
        type: 'svg-page' as any,
        x: oldX,
        y: oldY,
        isLocked: true,
        opacity: 0.9,
        props: { w: displayW, h: displayH, version: 0 },
      }])
      createdIds.push(shapeId)

      // "Earlier" label above old page
      const labelId = `${SHADOW_SHAPE_PREFIX}label-${op.pageNum}` as TLShapeId
      editor.createShapes([{
        id: labelId,
        type: 'text',
        x: oldX,
        y: oldY - 26,
        isLocked: true,
        opacity: 0.35,
        props: {
          richText: toRichText(formatLabelDate(hash)),
          font: 'sans',
          size: 's',
          color: 'grey',
          scale: 0.8,
        },
      }])
      createdIds.push(labelId)
    }
  })

  // Track overlay state
  overlayRef.current = { shapeIds: createdIds, hash }
  for (const id of createdIds) {
    shapeIdSetRef.current.add(id)
    shapeIdsArrayRef.current.push(id)
  }

  // Expand camera bounds to include old pages
  if (updateCameraBoundsRef.current && document.pages.length > 0) {
    const allBounds = document.pages.reduce(
      (acc, page) => acc.union(page.bounds),
      document.pages[0].bounds.clone(),
    )
    for (const op of fetchResults) {
      const currentPage = document.pages[op.pageNum - 1]
      if (!currentPage) continue
      const oldX = currentPage.bounds.x - TARGET_WIDTH - OLD_PAGE_GAP
      if (oldX < allBounds.x) {
        const diff = allBounds.x - oldX
        allBounds.x = oldX
        allBounds.w += diff
      }
    }
    updateCameraBoundsRef.current(allBounds)
  }
}

function removeOldShapes(
  editor: Editor | null,
  overlayRef: React.MutableRefObject<ShadowOverlayState | null>,
  shapeIdSetRef: React.MutableRefObject<Set<TLShapeId>>,
  shapeIdsArrayRef: React.MutableRefObject<TLShapeId[]>,
  document: SvgDocument,
) {
  if (!overlayRef.current) return
  const { shapeIds } = overlayRef.current

  if (editor) {
    editor.store.mergeRemoteChanges(() => {
      editor.store.remove(shapeIds as any)
    })
  }

  for (const id of shapeIds) {
    deleteSvgText(id)
    svgViewBoxStore.delete(id)
    shapeIdSetRef.current.delete(id)
  }
  shapeIdsArrayRef.current = shapeIdsArrayRef.current.filter(id => !shapeIds.includes(id))
  overlayRef.current = null
}

function parseSvgDimensions(svgText: string): {
  width: number; height: number
  viewBox: { minX: number; minY: number; width: number; height: number }
} {
  const vbMatch = svgText.match(/viewBox="([^"]+)"/)
  if (vbMatch) {
    const parts = vbMatch[1].split(/[\s,]+/).map(Number)
    if (parts.length === 4) {
      return {
        width: parts[2], height: parts[3],
        viewBox: { minX: parts[0], minY: parts[1], width: parts[2], height: parts[3] },
      }
    }
  }
  const wMatch = svgText.match(/width="([\d.]+)"/)
  const hMatch = svgText.match(/height="([\d.]+)"/)
  const w = wMatch ? parseFloat(wMatch[1]) : 612
  const h = hMatch ? parseFloat(hMatch[1]) : 792
  return { width: w, height: h, viewBox: { minX: 0, minY: 0, width: w, height: h } }
}

function formatLabelDate(hash: string): string {
  return `shadow ${hash.slice(0, 7)}`
}
