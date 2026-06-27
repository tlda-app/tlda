/**
 * useShadowOverlay — manages the shadow history scrubber and canvas overlay.
 *
 * Uses a time-axis model: the scrubber slider maps position to a timestamp,
 * then queries the server for the nearest real build at that time. Step buttons
 * move to the actual adjacent build (one save at a time). This handles repos
 * with hundreds of thousands of builds without sending the full version list.
 *
 * Shape creation is delegated to usePageColumn, which only creates shapes
 * for visible pages (plus prefetch) — avoiding the TLDraw hooks crash
 * that occurred when all pages were created at once.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import type { TLShapeId, Editor } from 'tldraw'
import { fetchShadowTimeBounds, fetchAdjacentShadowVersion, fetchShadowMeta, versionAtTime, fetchShadowChangelog } from '../historyStore'
import type { ShadowVersion, ShadowTimeBounds } from '../historyStore'
import type { ChangelogCommit } from '../overlays/SpaceTimeDots'
import type { SvgDocument } from '../svgDocumentLoader'
// @ts-ignore — vanilla JS module
import { getDeviceId, getHumanId, isDeviceReady } from '../fleet/fleet-data.mjs'

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

type LookupEntry = { page: number; y: number; content?: string }

async function fetchLookupLines(url: string): Promise<Record<string, LookupEntry> | null> {
  if (_lookupCache.has(url)) return _lookupCache.get(url)!
  try {
    const resp = await fetch(url)
    if (!resp.ok) return null
    const data = await resp.json()
    const lines = data.lines as Record<string, LookupEntry>
    _lookupCache.set(url, lines)
    return lines
  } catch { return null }
}

// Extract the first \label{...} from a LaTeX content string
function extractLabel(content: string | undefined): string | null {
  if (!content) return null
  const m = content.match(/\\label\{([^}]+)\}/)
  return m ? m[1] : null
}

// Build a label-name → entry map from a lookup record
function buildLabelMap(lines: Record<string, LookupEntry>): Map<string, LookupEntry> {
  const map = new Map<string, LookupEntry>()
  for (const entry of Object.values(lines)) {
    const label = extractLabel(entry.content)
    if (label) map.set(label, entry)
  }
  return map
}

export function useShadowOverlay(
  editorRef: React.MutableRefObject<Editor | null>,
  document: SvgDocument,
  docName: string,
  _shapeIdSetRef: React.MutableRefObject<Set<TLShapeId>>,
  _shapeIdsArrayRef: React.MutableRefObject<TLShapeId[]>,
  _updateCameraBoundsRef: React.MutableRefObject<((bounds: any) => void) | null>,
) {
  const [timeBounds, setTimeBounds] = useState<ShadowTimeBounds | null>(null)
  // activeVersion: null = showing current (no shadow column)
  const [activeVersion, setActiveVersion] = useState<ShadowVersion | null>(null)
  // committedVersion: debounced — column only updates after drag settles
  const [committedVersion, setCommittedVersion] = useState<ShadowVersion | null>(null)
  const [loading, setLoading] = useState(false)
  const [visible, setVisible] = useState(false)
  // Real page count for the committed shadow version (fetched after commit; falls back to current doc)
  const [shadowTotalPages, setShadowTotalPages] = useState(document.pages.length)
  // Y offset for the shadow column — aligned to viewport center on scrub
  const [shadowYOffset, setShadowYOffset] = useState(0)
  // Incrementing this re-runs the alignment effect without changing activeVersion
  const [alignCounter, setAlignCounter] = useState(0)
  // Changelog: per-commit page-level change data for the space-time overlay
  const [changelog, setChangelog] = useState<{ commits: ChangelogCommit[]; totalPages: number }>({ commits: [], totalPages: 0 })
  // Ref so the alignment effect always reads the latest pages without re-triggering
  const documentRef = useRef(document)
  documentRef.current = document

  // Fetch time bounds on mount and after new builds
  const fetchBounds = useCallback(async () => {
    const bounds = await fetchShadowTimeBounds(docName)
    setTimeBounds(bounds)
    return bounds
  }, [docName])

  useEffect(() => { fetchBounds() }, [fetchBounds])

  // Fetch changelog when scrubber becomes visible
  useEffect(() => {
    if (!visible) return
    fetchShadowChangelog(docName).then(data => {
      if (data) setChangelog(data)
    })
  }, [visible, docName])

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

  // Fetch real page count when committed version changes
  useEffect(() => {
    if (!committedVersion) {
      setShadowTotalPages(document.pages.length)
      return
    }
    fetchShadowMeta(docName, committedVersion.hash).then(meta => {
      setShadowTotalPages(meta.pages ?? document.pages.length)
    })
  }, [committedVersion?.hash, docName, document.pages.length])

  // Align shadow column Y to viewport center using SyncTeX label matching.
  // 1. Find the source line nearest to the viewport center in the current doc's lookup.
  // 2. Find that same line in the shadow version's lookup.
  // 3. Set yOffset so the shadow line appears at the viewport center.
  // If the shadow lookup isn't ready yet (DVI compile in progress), retries every 5s.
  // alignCounter lets callers force a re-alignment without changing the version.
  useEffect(() => {
    if (!committedVersion || !editorRef.current) { setShadowYOffset(0); return }
    let cancelled = false
    const editor = editorRef.current
    const hash7 = committedVersion.hash.slice(0, 7)
    const shadowLookupUrl = `/api/projects/${docName}/history/shadow/${hash7}/lookup`

    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const tryAlign = async () => {
      if (cancelled) return
      const vp = editor.getViewportPageBounds()
      const vpCenterY = vp.y + vp.h / 2

      const [currentLines, shadowLines] = await Promise.all([
        fetchLookupLines(`/docs/${docName}/lookup.json`),
        fetchLookupLines(shadowLookupUrl),
      ])

      if (cancelled) return

      // A successful fetch with empty lines means ensure.mjs produced a broken
      // lookup — that's a server-side bug, not a "not ready yet" condition.
      if (shadowLines !== null && Object.keys(shadowLines).length === 0) {
        throw new Error(`[useShadowOverlay] shadow lookup for ${shadowLookupUrl} fetched successfully but has 0 entries — server-side ensure bug`)
      }

      const pages = documentRef.current.pages
      if (currentLines && shadowLines && pages.length > 0) {
        const currentLabels = buildLabelMap(currentLines)
        const shadowLabels = buildLabelMap(shadowLines)

        // Find nearest label in either direction that exists in BOTH lookups.
        // Labels are stable semantic identifiers across versions — much more reliable
        // than line-number keys which shift when content is added/removed.
        // We search bidirectionally so that if vpCenterY sits just above a label
        // (e.g., right at a section heading), we still use the nearby label below.
        let bestLabel: string | null = null
        let bestDist = Infinity
        for (const [label, entry] of currentLabels) {
          if (!shadowLabels.has(label)) continue  // must exist in both
          const pg = pages[entry.page - 1]
          if (!pg) continue
          const scaleY = pg.bounds.height / PDF_HEIGHT
          const canvasY = pg.bounds.y + (entry.y + SYNCTEX_VIEWBOX_OFFSET) * scaleY
          const dist = Math.abs(canvasY - vpCenterY)
          if (dist < bestDist) { bestDist = dist; bestLabel = label }
        }

        if (bestLabel && shadowLabels.has(bestLabel)) {
          const curEntry = currentLabels.get(bestLabel)!
          const se = shadowLabels.get(bestLabel)!
          // L_current: where this label actually appears in the current column.
          // Use L_current (not vpCenterY) so the shadow label maps to the SAME
          // canvas position — aligning all pages, not just the visible center.
          const curPg = pages[curEntry.page - 1]
          if (curPg) {
            const curScaleY = curPg.bounds.height / PDF_HEIGHT
            const L_current = curPg.bounds.y + (curEntry.y + SYNCTEX_VIEWBOX_OFFSET) * curScaleY
            const shadowLineY = (se.page - 1) * PAGE_STRIDE + (se.y + SYNCTEX_VIEWBOX_OFFSET) * SCALE_Y
            setShadowYOffset(L_current - shadowLineY)
            return
          }
        }

      }

      // Shadow lookup not ready — retry in 5s. Clear cache so we re-fetch.
      _lookupCache.delete(shadowLookupUrl)
      retryTimer = setTimeout(tryAlign, 5000)
    }

    tryAlign()
    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [committedVersion?.hash, docName, alignCounter])

  const columnOptions: PageColumnOptions | null = useMemo(() => {
    if (!committedVersion || !visible) return null
    if (!isDeviceReady()) return null
    const userId = getHumanId()
    const deviceId = getDeviceId()
    if (!userId || !deviceId) return null
	    return {
	      docName,
	      source: { type: 'shadow' as const, docName, ref: committedVersion.hash },
	      owner: { userId, deviceId },
	      columnX,
      totalPages: shadowTotalPages,
      prefetch: 1,
      opacity: 0.9,
      yOffset: shadowYOffset,
    }
  }, [committedVersion?.hash, visible, docName, columnX, shadowTotalPages, shadowYOffset])

  usePageColumn(editorRef.current, columnOptions)

  // Show the overlay — navigate to most recent historical build so slider is visible
  const show = useCallback(async () => {
    let bounds = timeBounds
    if (!bounds) bounds = await fetchBounds()
    if (!bounds) return
    setVisible(true)
    // Start at the newest build (one step back from "current")
    const version = await versionAtTime(docName, bounds.newest.timestamp)
    if (version) {
      setActiveVersion(version)
      setCommittedVersion(version)
    }
  }, [timeBounds, fetchBounds, docName])

  // Hide the overlay
  const hide = useCallback(() => {
    setVisible(false)
    setActiveVersion(null)
    setCommittedVersion(null)
  }, [])

  const toggle = useCallback(() => {
    if (visible) hide()
    else show()
  }, [visible, hide, show])

  // Scrub handler — stable ref so the window-exposed function always has live setters.
  // Debounces column creation to avoid destroy/create churn while dragging.
  const settersRef = useRef({ setVisible, setActiveVersion, setCommittedVersion, setLoading })
  settersRef.current = { setVisible, setActiveVersion, setCommittedVersion, setLoading }
  const scrubTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Handle scrub by timestamp: query server for nearest build, then update UI.
  const handleScrubTime = useCallback((timestamp: number) => {
    const s = settersRef.current
    if (scrubTimerRef.current) { clearTimeout(scrubTimerRef.current); scrubTimerRef.current = null }
    s.setVisible(true)
    s.setLoading(true)
    scrubTimerRef.current = setTimeout(async () => {
      scrubTimerRef.current = null
      const version = await versionAtTime(docName, timestamp)
      if (version) {
        settersRef.current.setActiveVersion(version)
        settersRef.current.setCommittedVersion(version)
      }
      settersRef.current.setLoading(false)
    }, 200)
  }, [docName])

  // Handle scrub by known version object (from VersionStamp clicks)
  const handleScrubVersion = useCallback((version: ShadowVersion | null) => {
    const s = settersRef.current
    if (scrubTimerRef.current) { clearTimeout(scrubTimerRef.current); scrubTimerRef.current = null }
    if (!version) {
      s.setVisible(false)
      s.setActiveVersion(null)
      s.setCommittedVersion(null)
    } else {
      s.setVisible(true)
      s.setActiveVersion(version)
      s.setCommittedVersion(version)
    }
  }, [])

  // Handle step: fetch adjacent build and jump to it
  const handleStep = useCallback(async (dir: 'older' | 'newer') => {
    const s = settersRef.current
    if (dir === 'newer' && !activeVersion) return  // already at current
    const hash = activeVersion?.hash ?? timeBounds?.newest?.hash
    if (!hash) return
    if (dir === 'newer' && hash === timeBounds?.newest?.hash) {
      // step to current
      s.setVisible(false)
      s.setActiveVersion(null)
      s.setCommittedVersion(null)
      return
    }
    s.setLoading(true)
    const adjacent = await fetchAdjacentShadowVersion(docName, hash, dir)
    s.setLoading(false)
    if (adjacent) {
      s.setVisible(true)
      s.setActiveVersion(adjacent)
      s.setCommittedVersion(adjacent)
    }
  }, [activeVersion, timeBounds, docName])

  // Re-run SyncTeX alignment on the current version without changing it.
  const realignShadow = useCallback(() => {
    setAlignCounter(c => c + 1)
  }, [])

  // Expose on window for VersionStamp.
  // __shadowScrubVersion: accepts ShadowVersion | null (null = back to current)
  ;(window as any).__shadowScrubVersion = handleScrubVersion
  // Legacy alias kept for compatibility
  ;(window as any).__shadowScrub = (idx: number) => {
    if (idx < 0) handleScrubVersion(null)
  }

  return {
    shadowTimeBounds: timeBounds,
    shadowActiveVersion: activeVersion,
    shadowLoading: loading,
    shadowVisible: visible,
    shadowColumnX: columnX,
    shadowYOffset,
    shadowChangelog: changelog,
    showShadowOverlay: show,
    hideShadowOverlay: hide,
    toggleShadowOverlay: toggle,
    handleShadowScrubTime: handleScrubTime,
    handleShadowStep: handleStep,
    handleShadowScrubVersion: handleScrubVersion,
    refreshShadowTimeBounds: fetchBounds,
    realignShadow,
  }
}
