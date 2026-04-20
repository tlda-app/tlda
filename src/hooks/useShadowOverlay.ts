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
// SyncTeX y=0 is at the TeX reference point, 72pt from the top of the page (same as viewBox offset)
const SYNCTEX_VIEWBOX_OFFSET = 72
const SCALE_Y = PAGE_HEIGHT / PDF_HEIGHT

// Module-level cache so repeated scrubs don't re-fetch the same data
const _lookupCache = new Map<string, Record<string, { page: number; y: number }>>()

async function fetchLookupLines(url: string): Promise<Record<string, { page: number; y: number }> | null> {
  if (_lookupCache.has(url)) return _lookupCache.get(url)!
  try {
    const resp = await fetch(url)
    if (!resp.ok) return null
    const data = await resp.json()
    const lines = data.lines as Record<string, { page: number; y: number }>
    _lookupCache.set(url, lines)
    return lines
  } catch { return null }
}

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

  // Startup cleanup: sweep orphan shadow shapes left over from previous sessions.
  // Runs 1.5s after mount to ensure Yjs has synced and the editor is available.
  useEffect(() => {
    const timer = setTimeout(() => {
      const editor = editorRef.current
      if (!editor) return
      const toDelete = editor.getCurrentPageShapes().filter(s => {
        const id = s.id as string
        return id.startsWith('shape:shadow-col-handle-') || /^shape:col-\d+-shadow-/.test(id)
      })
      if (toDelete.length === 0) return
      for (const s of toDelete) {
        if (s.isLocked) editor.updateShape({ id: s.id, type: s.type, isLocked: false })
      }
      editor.deleteShapes(toDelete.map(s => s.id))
    }, 1500)
    return () => clearTimeout(timer)
  }, [])

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

  // Align shadow column Y to viewport center using SyncTeX label matching.
  // 1. Find the source line nearest to the viewport center in the current doc's lookup.
  // 2. Find that same line in the shadow version's lookup.
  // 3. Set yOffset so the shadow line appears at the viewport center.
  // Falls back to page-based alignment if lookups aren't available.
  useEffect(() => {
    if (!activeVersion || !editorRef.current) { setShadowYOffset(0); return }
    let cancelled = false
    const editor = editorRef.current
    const hash7 = activeVersion.hash.slice(0, 7)

    ;(async () => {
      const vp = editor.getViewportPageBounds()
      const vpCenterY = vp.y + vp.h / 2

      // Try SyncTeX label alignment
      const [currentLines, shadowLines] = await Promise.all([
        fetchLookupLines(`/docs/${docName}/lookup.json`),
        fetchLookupLines(`/api/projects/${docName}/history/shadow/${hash7}/lookup`),
      ])

      if (cancelled) return

      if (currentLines && shadowLines && document.pages.length > 0) {
        // Find the current-doc lookup entry whose canvas Y is nearest to viewport center
        let bestKey: string | null = null
        let bestDist = Infinity
        for (const [key, entry] of Object.entries(currentLines)) {
          const pg = document.pages[entry.page - 1]
          if (!pg) continue
          const scaleY = pg.bounds.height / PDF_HEIGHT
          const canvasY = pg.bounds.y + (entry.y + SYNCTEX_VIEWBOX_OFFSET) * scaleY
          const dist = Math.abs(canvasY - vpCenterY)
          if (dist < bestDist) { bestDist = dist; bestKey = key }
        }

        // Find the same key in shadow lookup and compute yOffset
        if (bestKey && shadowLines[bestKey]) {
          const se = shadowLines[bestKey]
          const shadowLineY = (se.page - 1) * PAGE_STRIDE + (se.y + SYNCTEX_VIEWBOX_OFFSET) * SCALE_Y
          setShadowYOffset(vpCenterY - shadowLineY)
          return
        }
      }

      if (cancelled) return

      // Fallback: page-based alignment
      const mainPage0 = document.pages[0]?.bounds.y ?? 0
      const nearestPage = Math.max(0, Math.min(
        shadowTotalPages - 1,
        Math.round((vpCenterY - mainPage0 - PAGE_HEIGHT / 2) / PAGE_STRIDE),
      ))
      setShadowYOffset(vpCenterY - nearestPage * PAGE_STRIDE - PAGE_HEIGHT / 2)
    })()

    return () => { cancelled = true }
  }, [activeVersion?.hash, shadowTotalPages, document.pages, docName])

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
