/**
 * useShadowOverlay — manages the shadow history scrubber and canvas overlay.
 *
 * Fetches shadow repo versions (one per successful build) and lets the user
 * scrub through them. When at a historical position, old SVGs are placed as
 * lazy-loaded TLDraw shapes alongside the current pages.
 *
 * Shape creation is delegated to usePageColumn, which only creates shapes
 * for visible pages (plus prefetch) — avoiding the TLDraw hooks crash
 * that occurred when all pages were created at once.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import type { TLShapeId, Editor } from 'tldraw'
import { fetchShadowVersions, fetchShadowMeta } from '../historyStore'
import type { ShadowVersion } from '../historyStore'
import type { SvgDocument } from '../svgDocumentLoader'

import { usePageColumn } from './usePageColumn'
import type { PageColumnOptions } from './usePageColumn'
import { PAGE_GAP, PDF_HEIGHT, PDF_WIDTH, TARGET_WIDTH } from '../layoutConstants'

const OLD_PAGE_GAP = 48
const PAGE_HEIGHT = PDF_HEIGHT * (TARGET_WIDTH / PDF_WIDTH)
const PAGE_STRIDE = PAGE_HEIGHT + PAGE_GAP

export function useShadowOverlay(
  editorRef: React.MutableRefObject<Editor | null>,
  document: SvgDocument,
  docName: string,
  _shapeIdSetRef: React.MutableRefObject<Set<TLShapeId>>,
  _shapeIdsArrayRef: React.MutableRefObject<TLShapeId[]>,
  _updateCameraBoundsRef: React.MutableRefObject<((bounds: any) => void) | null>,
) {
  const [versions, setVersions] = useState<ShadowVersion[]>([])
  const [activeIdx, setActiveIdx] = useState(-1)       // scrubber UI position (updates instantly)
  const [committedIdx, setCommittedIdx] = useState(-1)  // column version (debounced)
  const [loading, setLoading] = useState(false)
  const [visible, setVisible] = useState(false)
  // Real page count for the committed shadow version (fetched after commit; falls back to current doc)
  const [shadowTotalPages, setShadowTotalPages] = useState(document.pages.length)
  // Y offset for the shadow column — aligned to viewport center on scrub
  const [shadowYOffset, setShadowYOffset] = useState(0)
  const versionsRef = useRef(versions)
  versionsRef.current = versions

  // Fetch versions
  const fetchVersions = useCallback(async () => {
    const v = await fetchShadowVersions(docName)
    setVersions(v)
    versionsRef.current = v
    return v
  }, [docName])

  useEffect(() => { fetchVersions() }, [fetchVersions])

  const columnX = useMemo(() => {
    if (document.pages.length === 0) return 0
    const firstPage = document.pages[0]
    return firstPage.bounds.x + firstPage.bounds.width + OLD_PAGE_GAP
  }, [document.pages])

  // Build PageColumn options — null when no shadow is active.
  // Uses committedIdx (debounced) so rapid scrubbing doesn't churn columns.
  const activeVersion = committedIdx >= 0 && committedIdx < versions.length
    ? versions[committedIdx]
    : null

  // Fetch real page count when committed version changes
  useEffect(() => {
    if (!activeVersion) {
      setShadowTotalPages(document.pages.length)
      return
    }
    fetchShadowMeta(docName, activeVersion.hash).then(meta => {
      setShadowTotalPages(meta.pages ?? document.pages.length)
    })
  }, [activeVersion?.hash, docName, document.pages.length])

  // Align shadow column Y to viewport center when version or page count changes.
  // Find which page the viewport center lands on, clamp to shadow's page count,
  // then offset so that page appears at the viewport center Y.
  useEffect(() => {
    if (!activeVersion || !editorRef.current) { setShadowYOffset(0); return }
    const vp = editorRef.current.getViewportPageBounds()
    const vpCenterY = vp.y + vp.h / 2
    // Which page (0-indexed) of the main doc is at viewport center?
    const mainPage0 = document.pages[0]?.bounds.y ?? 0
    const nearestPage = Math.max(0, Math.min(
      shadowTotalPages - 1,
      Math.round((vpCenterY - mainPage0 - PAGE_HEIGHT / 2) / PAGE_STRIDE),
    ))
    // Place shadow page (nearestPage+1) so its center is at vpCenterY
    // shadow center = yOffset + nearestPage * PAGE_STRIDE + PAGE_HEIGHT / 2
    const newYOffset = vpCenterY - nearestPage * PAGE_STRIDE - PAGE_HEIGHT / 2
    setShadowYOffset(newYOffset)
  }, [activeVersion?.hash, shadowTotalPages, document.pages])

  const columnOptions: PageColumnOptions | null = useMemo(() => {
    if (!activeVersion || !visible) return null
    return {
      docName,
      source: { type: 'shadow' as const, docName, ref: activeVersion.hash },
      columnX,
      totalPages: shadowTotalPages,
      prefetch: 1,
      opacity: 0.9,
      yOffset: shadowYOffset,
    }
  }, [activeVersion?.hash, visible, docName, columnX, shadowTotalPages, shadowYOffset])

  // Delegate shape management to usePageColumn.
  // Cleanup is automatic: when columnOptions becomes null (visible=false or activeIdx=-1),
  // usePageColumn's reconciliation destroys the column and removes all shapes.
  usePageColumn(editorRef.current, columnOptions)

  // Show the overlay
  const show = useCallback(async () => {
    let v = versionsRef.current
    if (v.length === 0) {
      v = await fetchVersions()
    }
    setVisible(true)
    setActiveIdx(-1)
  }, [fetchVersions])

  // Hide the overlay
  const hide = useCallback(() => {
    setVisible(false)
    setActiveIdx(-1)
  }, [])

  const toggle = useCallback(() => {
    if (visible) hide()
    else show()
  }, [visible, hide, show])

  // Scrub handler — uses a ref so the window-exposed function always has
  // live state setters (survives component remounts from TLDraw/sync).
  // Debounces column creation to avoid destroy/create churn while dragging.
  const settersRef = useRef({ setVisible, setActiveIdx, setCommittedIdx, setLoading })
  settersRef.current = { setVisible, setActiveIdx, setCommittedIdx, setLoading }
  const scrubTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleScrub = useCallback((idx: number) => {
    const s = settersRef.current
    if (scrubTimerRef.current) { clearTimeout(scrubTimerRef.current); scrubTimerRef.current = null }

    if (idx < 0) {
      // Dismiss immediately
      s.setVisible(false)
      s.setActiveIdx(-1)
      s.setCommittedIdx(-1)
    } else {
      // Update scrubber UI immediately, debounce the column swap
      s.setVisible(true)
      s.setActiveIdx(idx)
      s.setLoading(true)
      scrubTimerRef.current = setTimeout(() => {
        scrubTimerRef.current = null
        settersRef.current.setCommittedIdx(idx)
        settersRef.current.setLoading(false)
      }, 300)
    }
  }, [])

  // Expose on window for VersionStamp and testing.
  ;(window as any).__shadowScrub = handleScrub

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
