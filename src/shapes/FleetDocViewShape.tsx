/**
 * FleetDocViewShape — fleet HUD shape showing a region of the current document.
 *
 * Instead of fixed modes, the shape subscribes to event *sources*. When any
 * subscribed source fires, the shape shows the relevant document region.
 * Priority: errors > ref > proof (proof is continuous/background).
 *
 * Sources:
 *   - 'ref':    fired when user clicks a cross-reference in the document
 *   - 'proof':  auto-tracks the theorem statement for the currently visible proof
 *   - 'errors': shows the error region when a build has errors
 *
 * Data flows:
 *   - proof-info.json provides label regions + proof pairs
 *   - Main editor scroll position determines which proof is visible
 *   - onBuildStatusSignal delivers build errors
 *   - SvgDocument dispatches ref clicks by updating shape props directly
 *   - CanvasClipPanel renders the doc region from the main editor's store
 */
import {
  BaseBoxShapeUtil,
  HTMLContainer,
  T,
  createShapeId,
  stopEventPropagation,
  useEditor,
  useValue,
} from 'tldraw'
import type { Editor } from 'tldraw'
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { CanvasClipPanel, type ClipBounds } from '../CanvasClipPanel'
import { DocContext } from '../PanelContext'
import { PDF_HEIGHT } from '../layoutConstants'
import { onBuildStatusSignal, type BuildError } from '../useYjsSync'
import { loadLookup } from '../synctexLookup'
import { pdfToCanvas } from '../synctexAnchor'
import { getSvgText, setSvgText } from '../stores/svgTextStore'
import { getPageUrl } from '../stores/pageUrlStore'
import { getPref } from '../preferences'
import { beginNativeSnapDrag, endNativeSnapDrag, FLEET_SHAPE_TYPES } from './fleet-utils'
import { createFleetDocviewSurface, type FleetDocviewSurfaceState } from '../wm/fleet-docview-layer'

const DEFAULT_W = 300
const DEFAULT_H = 250

const ALL_SOURCES = ['ref', 'proof', 'errors'] as const
type Source = typeof ALL_SOURCES[number]
type FleetDocviewWindow = Window & {
  __tlda_wm_docviews__?: Record<string, FleetDocviewSurfaceState>
}

function parseSources(s: string | undefined): Source[] {
  try {
    const arr = JSON.parse(s ?? 'null')
    if (Array.isArray(arr)) return arr.filter((x): x is Source => ALL_SOURCES.includes(x as Source))
  } catch {}
  return ['ref']
}

interface ResolvedErrorBounds {
  error: BuildError
  bounds: ClipBounds
}

function findNearestLine(
  lines: Array<{ line: number; file: string; page: number; x: number; y: number }>,
  targetLine: number,
  targetFile: string
): { line: number; file: string; page: number; x: number; y: number } | null {
  const fileLines = lines.filter(l =>
    l.file === targetFile ||
    l.file?.endsWith('/' + targetFile) ||
    targetFile?.endsWith('/' + l.file)
  )
  if (fileLines.length === 0) return null
  return fileLines.reduce((best, cur) =>
    Math.abs(cur.line - targetLine) < Math.abs(best.line - targetLine) ? cur : best
  )
}

export class FleetDocViewShapeUtil extends BaseBoxShapeUtil<any> {
  static override type = 'fleet-docview' as const
  static override props = {
    w: T.number,
    h: T.number,
    sources: T.optional(T.string),  // JSON array of Source values, e.g. '["ref","proof","errors"]'
    mode: T.optional(T.string),    // legacy — ignored, accepted for backwards compat with old Yjs stores
    label: T.string,    // current ref label key, set by ref click
    page: T.number,     // current ref page, set by ref click
    yTop: T.number,     // current ref region top (PDF coords)
    yBottom: T.number,  // current ref region bottom (PDF coords)
    title: T.string,    // display title
    userId: T.optional(T.string),
    deviceId: T.optional(T.string),
  }

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H, sources: JSON.stringify(getPref('docview-sources')), label: '', page: 0, yTop: 0, yBottom: 0, title: '', userId: '', deviceId: '' }
  }

  override canSnap = () => true
  override onTranslateStart = () => beginNativeSnapDrag(this.editor)
  override onTranslateEnd = () => endNativeSnapDrag(this.editor)
  override onTranslateCancel = () => endNativeSnapDrag(this.editor)

  component(shape: any) {
    return (
      <HTMLContainer style={{ pointerEvents: 'all' }}>
        <FleetDocViewComponent shape={shape} />
      </HTMLContainer>
    )
  }

  getIndicatorPath(shape: any) {
    const path = new Path2D()
    path.rect(0, 0, shape.props.w, shape.props.h)
    return path
  }

  indicator(shape: any) {
    return <rect width={shape.props.w} height={shape.props.h} />
  }
}

interface NavEntry { label: string; page: number; yTop: number; yBottom: number; title: string }

function FleetDocViewComponent({ shape }: { shape: any }) {
  const editor = useEditor()
  const doc = useContext(DocContext)
  const isSelected = useValue('docview-selected', () => editor.getSelectedShapeIds().includes(shape.id), [editor, shape.id])
  const containerRef = useRef<HTMLDivElement>(null)
  const isSelectedRef = useRef(false)
  isSelectedRef.current = isSelected

  // Capture-phase pointerdown: fires before tldraw's tl-container listener
  // can intercept. Marks clicks as handled so tldraw skips setPointerCapture.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    function onPointerDown(e: PointerEvent) {
      const target = e.target as HTMLElement
      if (!el!.contains(target)) return
      if (isSelectedRef.current) return
      editor.markEventAsHandled(e)
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [editor])

  const { w, h, sources: sourcesRaw, label, page, yTop, yBottom, title } = shape.props
  const sources = parseSources(sourcesRaw)

  const mainEditor = (window as any).__tldraw_editor__ as Editor | undefined

  // --- Return button: save camera before Go, restore on Return ---
  const [savedCamera, setSavedCamera] = useState<{ x: number; y: number; z: number } | null>(null)

  // --- Filter overlay ---
  const [showSources, setShowSources] = useState(false)

  // --- Error source ---
  const [buildErrors, setBuildErrors] = useState<BuildError[]>([])
  const [errorIndex, setErrorIndex] = useState(0)
  const [resolvedErrors, setResolvedErrors] = useState<ResolvedErrorBounds[]>([])

  useEffect(() => {
    if (!sources.includes('errors')) return
    return onBuildStatusSignal((signal) => {
      setBuildErrors(signal.errors || [])
      setErrorIndex(0)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcesRaw])

  useEffect(() => {
    if (!doc?.docName || buildErrors.length === 0) { setResolvedErrors([]); return }
    let cancelled = false
    async function resolve() {
      const lookup = await loadLookup(doc!.docName)
      if (cancelled || !lookup) return
      const out: ResolvedErrorBounds[] = []
      for (const err of buildErrors) {
        if (!err.line) continue
        const entry = findNearestLine(lookup.lines as any, err.line, err.file)
        if (!entry) continue
        const canvas = pdfToCanvas(entry.page, entry.x, entry.y, doc!.pages)
        if (!canvas) continue
        const pageBounds = doc!.pages[entry.page - 1]?.bounds
        if (!pageBounds) continue
        out.push({
          error: err,
          bounds: { x: pageBounds.x, y: canvas.y - 40, w: pageBounds.width, h: 80 },
        })
      }
      if (!cancelled) setResolvedErrors(out)
    }
    resolve()
    return () => { cancelled = true }
  }, [buildErrors, doc])

  // --- Ref navigation history ---
  const [history, setHistory] = useState<NavEntry[]>([])
  const [historyIdx, setHistoryIdx] = useState(-1)
  const suppressNextPushRef = useRef(false)

  useEffect(() => {
    if (suppressNextPushRef.current) { suppressNextPushRef.current = false; return }
    if (!page && !label) return
    const entry: NavEntry = { label, page, yTop, yBottom, title }
    setHistory(prev => {
      const trimmed = prev.slice(0, historyIdx + 1)
      const last = trimmed[trimmed.length - 1]
      if (last && last.label === entry.label && last.page === entry.page &&
          last.yTop === entry.yTop && last.yBottom === entry.yBottom) return prev
      return [...trimmed, entry]
    })
    setHistoryIdx(idx => idx + 1)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label, page, yTop, yBottom])

  // --- Proof info ---
  const [proofInfo, setProofInfo] = useState<any>(null)
  useEffect(() => {
    if (!doc?.docName) return
    fetch(`/docs/${doc.docName}/proof-info.json?t=${Date.now()}`)
      .then(r => r.ok ? r.json() : null)
      .then(setProofInfo)
      .catch(e => console.warn('[doc-view] proof-info fetch failed:', e.message))
  }, [doc?.docName])

  // Track main editor viewport for proof source — useValue can't track cross-editor
  // reactive reads, so poll the main editor's viewport on camera changes.
  const [mainViewportY, setMainViewportY] = useState(0)
  useEffect(() => {
    if (!sources.includes('proof') || !mainEditor) return
    const update = () => {
      const vp = mainEditor.getViewportPageBounds()
      setMainViewportY(vp.y + vp.h / 2)
    }
    update()
    // Listen for ANY store change and check if camera moved —
    // camera record keys vary across tldraw versions
    let lastCamY = mainEditor.getCamera().y
    const unsub = mainEditor.store.listen(() => {
      const cam = mainEditor.getCamera()
      if (cam.y !== lastCamY) {
        lastCamY = cam.y
        update()
      }
    })
    return unsub
  }, [mainEditor, sourcesRaw])

  // --- Compute display bounds (priority: errors > ref > proof) ---
  const bounds = useValue('docview-bounds', (): ClipBounds | null => {
    // Errors: highest priority when active
    if (doc?.pages?.length && sources.includes('errors') && resolvedErrors.length > 0) {
      const item = resolvedErrors[Math.min(errorIndex, resolvedErrors.length - 1)]
      return item?.bounds ?? null
    }

    if (!doc?.pages?.length) return null

    // Ref: pinned region from last click
    let refBounds: ClipBounds | null = null
    if (sources.includes('ref') && proofInfo?.labelRegions && label) {
      const region = proofInfo.labelRegions[label]
      if (region) {
        const pageIdx = region.page - 1
        if (pageIdx >= 0 && pageIdx < doc.pages.length) {
          const pageBounds = doc.pages[pageIdx].bounds
          const scale = pageBounds.height / PDF_HEIGHT
          const canvasYTop = pageBounds.y + (region.yTop || 0) * scale
          const canvasYBottom = pageBounds.y + (region.yBottom || pageBounds.height / scale) * scale
          const regionH = Math.max(canvasYBottom - canvasYTop, pageBounds.height * 0.15)
          refBounds = { x: pageBounds.x, y: canvasYTop - 20, w: pageBounds.width, h: regionH + 40 }
        }
      }
    }
    if (!refBounds && sources.includes('ref') && page > 0) {
      const pageIdx = page - 1
      if (pageIdx >= 0 && pageIdx < doc.pages.length) {
        const pageBounds = doc.pages[pageIdx].bounds
        const scale = pageBounds.height / PDF_HEIGHT
        refBounds = {
          x: pageBounds.x,
          y: pageBounds.y + (yTop || 0) * scale,
          w: pageBounds.width,
          h: ((yBottom || PDF_HEIGHT) - (yTop || 0)) * scale,
        }
      }
    }

    // Proof: auto-track from viewport — takes priority when actively in a proof,
    // otherwise falls back to the last ref click
    if (sources.includes('proof') && proofInfo?.pairs && mainViewportY > 0) {
      for (const pair of proofInfo.pairs) {
        // Check ALL proof regions — multi-page proofs span several pages
        const proofRegions = pair.proofRegions || (pair.proofRegion ? [pair.proofRegion] : [])
        const stmtRegions = pair.statementRegions || (pair.statementRegion ? [pair.statementRegion] : [])
        const statementRegion = stmtRegions.length > 1
          ? stmtRegions.reduce((best: any, r: any) => (!best || (r.yBottom - r.yTop) > (best.yBottom - best.yTop)) ? r : best, null)
          : stmtRegions[0]
        if (!proofRegions.length || !statementRegion) continue

        let inProof = false
        for (const proofRegion of proofRegions) {
          const proofPageIdx = proofRegion.page - 1
          if (proofPageIdx < 0 || proofPageIdx >= doc.pages.length) continue
          const proofPageBounds = doc.pages[proofPageIdx].bounds
          const scale = proofPageBounds.height / PDF_HEIGHT
          const proofTop = proofPageBounds.y + (proofRegion.yTop || 0) * scale
          const proofBottom = proofPageBounds.y + (proofRegion.yBottom || PDF_HEIGHT) * scale
          if (mainViewportY >= proofTop && mainViewportY <= proofBottom) { inProof = true; break }
        }
        if (inProof) {
          const stmtPageIdx = statementRegion.page - 1
          if (stmtPageIdx < 0 || stmtPageIdx >= doc.pages.length) continue
          const stmtPageBounds = doc.pages[stmtPageIdx].bounds
          const stmtScale = stmtPageBounds.height / PDF_HEIGHT
          const stmtTop = stmtPageBounds.y + (statementRegion.yTop || 0) * stmtScale
          const stmtBottom = stmtPageBounds.y + (statementRegion.yBottom || PDF_HEIGHT) * stmtScale
          return {
            x: stmtPageBounds.x,
            y: stmtTop - 10,
            w: stmtPageBounds.width,
            h: Math.max(stmtBottom - stmtTop + 20, stmtPageBounds.height * 0.1),
          }
        }
      }
      // Not in a proof — fall back to ref if available
      return refBounds
    }

    // Only ref, no proof source
    return refBounds
  }, [doc, sources, label, page, yTop, yBottom, proofInfo, mainEditor, mainViewportY, resolvedErrors, errorIndex])

  // Prefetch SVG for the page the bounds point to — the clip panel needs it
  // loaded in svgTextStore even if the page is outside the main viewport.
  // Track readiness as state so the clip panel doesn't mount until the SVG is available.
  const [svgReady, setSvgReady] = useState(false)
  const boundsPageIdx = useMemo(() => {
    if (!bounds || !doc?.pages?.length) return -1
    const centerY = bounds.y + bounds.h / 2
    for (let i = 0; i < doc.pages.length; i++) {
      const p = doc.pages[i]
      if (centerY >= p.bounds.y && centerY <= p.bounds.y + p.bounds.height) return i
    }
    return -1
  }, [bounds, doc])

  useEffect(() => {
    if (boundsPageIdx < 0 || !doc?.pages?.length || !doc?.docName) { setSvgReady(false); return }
    const p = doc.pages[boundsPageIdx]
    const sid = p.shapeId as string
    if (!sid) { setSvgReady(false); return }
    if (getSvgText(sid)) { setSvgReady(true); return }
    // Not loaded — fetch and set ready when done
    setSvgReady(false)
    const url = getPageUrl(boundsPageIdx)
    if (!url) return
    fetch(url)
      .then(r => r.ok ? r.text() : null)
      .then(text => {
        if (text) {
          setSvgText(sid, text)
          setSvgReady(true)
        }
      })
      .catch(e => console.warn('[doc-view] SVG fetch failed:', e.message))
  }, [boundsPageIdx, doc])

  const activeSource: Source | null =
    (sources.includes('errors') && resolvedErrors.length > 0) ? 'errors' :
    (sources.includes('ref') && (label || page > 0)) ? 'ref' :
    sources.includes('proof') ? 'proof' : null

  const currentError = activeSource === 'errors'
    ? resolvedErrors[Math.min(errorIndex, resolvedErrors.length - 1)]?.error ?? null
    : null
  const errorHeaderH = 22
  const panelH = currentError ? h - errorHeaderH : h

  const shapeUtils = useMemo(() => {
    const all = (window as any).__tldraw_shape_utils__ || []
    const excluded = new Set([...FLEET_SHAPE_TYPES, 'fleet-pill'])
    return all.filter((u: any) => !excluded.has(u.type))
  }, [])
  const licenseKey = 'tldraw-2027-01-19/WyJhUGMwcWRBayIsWyIqLnF0bTI4NS5naXRodWIuaW8iXSw5LCIyMDI3LTAxLTE5Il0.Hq9z1V8oTLsZKgpB0pI3o/RXCoLOsh5Go7Co53YGqHNmtEO9Lv/iuyBPzwQwlxQoREjwkkFbpflOOPmQMwvQSQ'

  const docviewSurface = useMemo<FleetDocviewSurfaceState | null>(() => {
    if (!bounds || boundsPageIdx < 0 || !doc?.pages?.[boundsPageIdx]) return null
    const pageBounds = doc.pages[boundsPageIdx].bounds
    return createFleetDocviewSurface({
      shapeId: shape.id,
      bounds,
      pageBounds: { x: pageBounds.x, y: pageBounds.y, w: pageBounds.width, h: pageBounds.height },
      panelWidth: w,
      panelHeight: panelH,
      userId: shape.props.userId,
      deviceId: shape.props.deviceId,
      source: activeSource,
    })
  }, [shape.id, shape.props.userId, shape.props.deviceId, bounds, boundsPageIdx, doc, w, panelH, activeSource])

  useEffect(() => {
    const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null
    const exposeForTest = params?.has('pw') || params?.has('wmDocviewGate')
    if (!(import.meta.env.DEV || exposeForTest || (typeof navigator !== 'undefined' && navigator.webdriver))) return
    const registry = ((window as FleetDocviewWindow).__tlda_wm_docviews__ ??= {})
    if (docviewSurface) registry[shape.id] = docviewSurface
    return () => { delete registry[shape.id] }
  }, [shape.id, docviewSurface])

  if (!mainEditor || !doc) {
    return (
      <div style={{ width: w, height: h, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.3, fontSize: 11 }}>
        No document
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="fleet-docview fleet-shape"
      style={{ width: w, height: h, position: 'relative' }}
      onPointerDown={stopEventPropagation}
    >
      {/* Sources filter overlay — covers the whole shape */}
      {showSources && (
        <div className="docview-sources-overlay" onPointerDown={(e: any) => e.stopPropagation()}>
          <div className="docview-sources-header">
            <span>Sources</span>
          </div>
          {ALL_SOURCES.map(src => (
            <label key={src} className="docview-source-row" onPointerDown={(e: any) => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={sources.includes(src)}
                onChange={(e) => {
                  const newSources = e.target.checked
                    ? [...sources, src]
                    : sources.filter(s => s !== src)
                  if (!mainEditor) return
                  const s = mainEditor.getShape(shape.id) as any
                  if (s?.isLocked) mainEditor.updateShape({ id: shape.id, type: shape.type, isLocked: false })
                  mainEditor.updateShape({
                    id: shape.id, type: shape.type,
                    props: { ...shape.props, sources: JSON.stringify(newSources) },
                  })
                }}
              />
              <span>
                {src === 'ref' ? 'References' : src === 'proof' ? 'Proof tracker' : 'Build errors'}
              </span>
            </label>
          ))}
        </div>
      )}

      {/* Right-edge button group */}
      <div className="fleet-btn-group" onPointerDown={(e: any) => e.stopPropagation()}>
        <button
          className={`fleet-layout-btn${showSources ? ' active' : ''}`}
          onPointerUp={(e: any) => { e.stopPropagation(); setShowSources(v => !v) }}
          title={showSources ? 'Back to viewer' : 'Configure sources'}
        >{showSources ? '▢' : '⊛'}</button>
        <button
          className="fleet-layout-btn"
          onPointerUp={(e: any) => {
            e.stopPropagation()
            if (!mainEditor) return
            const newId = createShapeId()
            mainEditor.createShape({
              id: newId, type: 'fleet-docview' as any,
              x: shape.x + w / 2 + 5, y: shape.y, isLocked: false,
              props: { w: w / 2 - 5, h, sources: sourcesRaw, label, page, yTop, yBottom, title },
            })
            if (mainEditor.getShape(shape.id)?.isLocked) mainEditor.updateShape({ id: shape.id, type: shape.type, isLocked: false })
            mainEditor.updateShape({ id: shape.id, type: shape.type, props: { ...shape.props, w: w / 2 - 5 } })
          }}
          title="Split vertical"
        >⬒</button>
        <button
          className="fleet-layout-btn"
          onPointerUp={(e: any) => {
            e.stopPropagation()
            if (!mainEditor) return
            const newId = createShapeId()
            mainEditor.createShape({
              id: newId, type: 'fleet-docview' as any,
              x: shape.x, y: shape.y + h / 2 + 5, isLocked: false,
              props: { w, h: h / 2 - 5, sources: sourcesRaw, label, page, yTop, yBottom, title },
            })
            if (mainEditor.getShape(shape.id)?.isLocked) mainEditor.updateShape({ id: shape.id, type: shape.type, isLocked: false })
            mainEditor.updateShape({ id: shape.id, type: shape.type, props: { ...shape.props, h: h / 2 - 5 } })
          }}
          title="Split horizontal"
        >⬓</button>
        <button
          className="fleet-layout-btn"
          onPointerUp={(e: any) => { e.stopPropagation(); editor.setCurrentTool('select'); editor.select(shape.id) }}
          title="Resize / move"
        >⊞</button>
        <button
          className="fleet-close-btn"
          onPointerUp={(e: any) => { e.stopPropagation(); editor.deleteShapes([shape.id]) }}
        >×</button>
      </div>

      {/* Top-right nav group */}
      <div className="fleet-btn-group fleet-btn-group-topright" onPointerDown={(e: any) => e.stopPropagation()}>
        {activeSource === 'errors' && resolvedErrors.length > 1 ? (
          <>
            <button
              className="fleet-layout-btn"
              disabled={errorIndex === 0}
              onPointerUp={(e: any) => { e.stopPropagation(); setErrorIndex(i => Math.max(0, i - 1)) }}
              title="Previous error"
            >←</button>
            <span className="docview-error-count">
              {errorIndex + 1}/{resolvedErrors.length}
            </span>
            <button
              className="fleet-layout-btn"
              disabled={errorIndex >= resolvedErrors.length - 1}
              onPointerUp={(e: any) => { e.stopPropagation(); setErrorIndex(i => Math.min(resolvedErrors.length - 1, i + 1)) }}
              title="Next error"
            >→</button>
          </>
        ) : (
          <>
            <button
              className="fleet-layout-btn"
              disabled={historyIdx <= 0}
              onPointerUp={(e: any) => {
                e.stopPropagation()
                if (historyIdx <= 0 || !mainEditor) return
                const newIdx = historyIdx - 1
                const entry = history[newIdx]
                setHistoryIdx(newIdx)
                suppressNextPushRef.current = true
                if (mainEditor.getShape(shape.id)?.isLocked) mainEditor.updateShape({ id: shape.id, type: shape.type, isLocked: false })
                mainEditor.updateShape({ id: shape.id, type: shape.type, props: { ...shape.props, ...entry } })
              }}
              title="Back"
            >←</button>
            <button
              className="fleet-layout-btn"
              disabled={historyIdx >= history.length - 1}
              onPointerUp={(e: any) => {
                e.stopPropagation()
                if (historyIdx >= history.length - 1 || !mainEditor) return
                const newIdx = historyIdx + 1
                const entry = history[newIdx]
                setHistoryIdx(newIdx)
                suppressNextPushRef.current = true
                if (mainEditor.getShape(shape.id)?.isLocked) mainEditor.updateShape({ id: shape.id, type: shape.type, isLocked: false })
                mainEditor.updateShape({ id: shape.id, type: shape.type, props: { ...shape.props, ...entry } })
              }}
              title="Forward"
            >→</button>
            <button
              className="fleet-layout-btn"
              onPointerDown={(e: any) => {
                e.stopPropagation()
                if (!mainEditor || !bounds) return
                const startX = e.clientX
                const startY = e.clientY
                let dragged = false
                let ghost: HTMLDivElement | null = null

                const onMove = (ev: PointerEvent) => {
                  if (!dragged && (Math.abs(ev.clientX - startX) > 5 || Math.abs(ev.clientY - startY) > 5)) {
                    dragged = true
                    // Create ghost preview
                    ghost = document.createElement('div')
                    ghost.style.cssText = 'position:fixed;width:400px;height:300px;border:2px solid rgba(128,128,128,0.4);border-radius:2px;background:rgba(255,255,255,0.05);pointer-events:none;z-index:99999;'
                    document.body.appendChild(ghost)
                  }
                  if (ghost) {
                    ghost.style.left = (ev.clientX - 200) + 'px'
                    ghost.style.top = (ev.clientY - 150) + 'px'
                  }
                }
                const onUp = (ev: PointerEvent) => {
                  window.removeEventListener('pointermove', onMove)
                  window.removeEventListener('pointerup', onUp)
                  if (ghost) { ghost.remove(); ghost = null }

                  if (dragged) {
                    // Drag → peel off doc-clip at drop point
                    let clipPage = 0
                    let clipYTop = 0
                    let clipYBottom = 300
                    if (doc?.pages?.length) {
                      const centerY = bounds.y + bounds.h / 2
                      for (let i = 0; i < doc.pages.length; i++) {
                        const pb = doc.pages[i].bounds
                        if (centerY >= pb.y && centerY <= pb.y + pb.height) {
                          clipPage = i + 1
                          const scale = pb.height / PDF_HEIGHT
                          clipYTop = Math.max(0, (bounds.y - pb.y) / scale)
                          clipYBottom = Math.min(PDF_HEIGHT, (bounds.y + bounds.h - pb.y) / scale)
                          break
                        }
                      }
                    }
                    if (clipPage <= 0) return
                    const dropPage = mainEditor.screenToPage({ x: ev.clientX, y: ev.clientY })
                    mainEditor.createShape({
                      id: createShapeId(),
                      type: 'doc-clip' as any,
                      x: dropPage.x - 200,
                      y: dropPage.y - 150,
                      isLocked: false,
                      props: {
                        w: 400,
                        h: 300,
                        page: clipPage,
                        yTop: Math.round(clipYTop),
                        yBottom: Math.round(clipYBottom),
                        label: title || label || '',
                      },
                    })
                  } else {
                    // Click → navigate to location
                    const cam = mainEditor.getCamera()
                    setSavedCamera({ x: cam.x, y: cam.y, z: cam.z })
                    const vp = mainEditor.getViewportPageBounds()
                    mainEditor.centerOnPoint(
                      { x: vp.x + vp.w / 2, y: bounds.y + bounds.h / 2 },
                      { animation: { duration: 300 } }
                    )
                  }
                }
                window.addEventListener('pointermove', onMove)
                window.addEventListener('pointerup', onUp)
              }}
              title="Click: go to location. Drag: peel off to canvas."
            >↗</button>
            {savedCamera && (
              <button
                className="fleet-layout-btn"
                onPointerUp={(e: any) => {
                  e.stopPropagation()
                  if (!mainEditor || !savedCamera) return
                  mainEditor.setCamera(savedCamera, { animation: { duration: 300 } })
                  setSavedCamera(null)
                }}
                title="Return to previous position"
              >↩</button>
            )}
          </>
        )}
      </div>

      {/* Error message header */}
      {activeSource === 'errors' && currentError && (
        <div className="docview-error-header" onPointerDown={(e: any) => e.stopPropagation()}>
          <span className="docview-error-msg" title={currentError.message}>
            {currentError.line ? `l.${currentError.line} ` : ''}{currentError.message.slice(0, 90)}
          </span>
        </div>
      )}

      <div
        className="fleet-docview-body"
        style={{ height: panelH }}
      >
        {bounds && docviewSurface && mainEditor && svgReady ? (
          <CanvasClipPanel
            mainEditor={mainEditor}
            bounds={bounds}
            shapeUtils={shapeUtils}
            tools={[]}
            licenseKey={licenseKey}
            panelWidth={w}
            maxHeightFraction={1}
            readOnly
            viewportId={docviewSurface.viewportId}
            cameraOverride={docviewSurface.camera}
            wmSurface={{ surfaceId: docviewSurface.surfaceId, layerId: docviewSurface.layerId }}
          />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', opacity: 0.15, fontSize: 11 }}>
            {activeSource === 'proof' ? 'scroll to a proof' :
             activeSource === 'ref' ? 'click a ref' :
             sources.length === 0 ? 'no sources' : 'waiting…'}
          </div>
        )}
      </div>
    </div>
  )
}
