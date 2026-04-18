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
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CanvasClipPanel, type ClipBounds } from '../CanvasClipPanel'
import { DocContext } from '../PanelContext'
import { PDF_HEIGHT } from '../layoutConstants'
import { onBuildStatusSignal, type BuildError } from '../useYjsSync'
import { loadLookup } from '../synctexLookup'
import { pdfToCanvas } from '../synctexAnchor'

const DEFAULT_W = 300
const DEFAULT_H = 250

const ALL_SOURCES = ['ref', 'proof', 'errors'] as const
type Source = typeof ALL_SOURCES[number]

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
  }

  getDefaultProps() {
    return { w: DEFAULT_W, h: DEFAULT_H, sources: '["ref"]', label: '', page: 0, yTop: 0, yBottom: 0, title: '' }
  }

  component(shape: any) {
    return (
      <HTMLContainer style={{ pointerEvents: 'all' }}>
        <FleetDocViewComponent shape={shape} />
      </HTMLContainer>
    )
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
      .catch(() => {})
  }, [doc?.docName])

  // --- Compute display bounds (priority: errors > ref > proof) ---
  const bounds = useValue('docview-bounds', (): ClipBounds | null => {
    if (!doc?.pages?.length) return null

    // Errors: highest priority when active
    if (sources.includes('errors') && resolvedErrors.length > 0) {
      const item = resolvedErrors[Math.min(errorIndex, resolvedErrors.length - 1)]
      return item?.bounds ?? null
    }

    // Ref: pinned region from last click
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
          return { x: pageBounds.x, y: canvasYTop - 20, w: pageBounds.width, h: regionH + 40 }
        }
      }
    }
    if (sources.includes('ref') && page > 0) {
      const pageIdx = page - 1
      if (pageIdx >= 0 && pageIdx < doc.pages.length) {
        const pageBounds = doc.pages[pageIdx].bounds
        const scale = pageBounds.height / PDF_HEIGHT
        return {
          x: pageBounds.x,
          y: pageBounds.y + (yTop || 0) * scale,
          w: pageBounds.width,
          h: ((yBottom || PDF_HEIGHT) - (yTop || 0)) * scale,
        }
      }
    }

    // Proof: background auto-track from viewport
    if (sources.includes('proof') && proofInfo?.proofPairs && mainEditor) {
      const viewport = mainEditor.getViewportPageBounds()
      const viewCenterY = viewport.y + viewport.h / 2
      for (const pair of proofInfo.proofPairs) {
        if (!pair.proofRegion || !pair.statementRegion) continue
        const proofPageIdx = pair.proofRegion.page - 1
        if (proofPageIdx < 0 || proofPageIdx >= doc.pages.length) continue
        const proofPageBounds = doc.pages[proofPageIdx].bounds
        const scale = proofPageBounds.height / PDF_HEIGHT
        const proofTop = proofPageBounds.y + (pair.proofRegion.yTop || 0) * scale
        const proofBottom = proofPageBounds.y + (pair.proofRegion.yBottom || PDF_HEIGHT) * scale
        if (viewCenterY >= proofTop && viewCenterY <= proofBottom) {
          const stmtPageIdx = pair.statementRegion.page - 1
          if (stmtPageIdx < 0 || stmtPageIdx >= doc.pages.length) continue
          const stmtPageBounds = doc.pages[stmtPageIdx].bounds
          const stmtScale = stmtPageBounds.height / PDF_HEIGHT
          const stmtTop = stmtPageBounds.y + (pair.statementRegion.yTop || 0) * stmtScale
          const stmtBottom = stmtPageBounds.y + (pair.statementRegion.yBottom || PDF_HEIGHT) * stmtScale
          return {
            x: stmtPageBounds.x,
            y: stmtTop - 10,
            w: stmtPageBounds.width,
            h: Math.max(stmtBottom - stmtTop + 20, stmtPageBounds.height * 0.1),
          }
        }
      }
      return null
    }

    return null
  }, [doc, sources, label, page, yTop, yBottom, proofInfo, mainEditor, resolvedErrors, errorIndex])

  const activeSource: Source | null =
    (sources.includes('errors') && resolvedErrors.length > 0) ? 'errors' :
    (sources.includes('ref') && (label || page > 0)) ? 'ref' :
    sources.includes('proof') ? 'proof' : null

  const currentError = activeSource === 'errors'
    ? resolvedErrors[Math.min(errorIndex, resolvedErrors.length - 1)]?.error ?? null
    : null

  const shapeUtils = useMemo(() => {
    const all = (window as any).__tldraw_shape_utils__ || []
    const FLEET_TYPES = new Set(['fleet-chat', 'fleet-agents', 'fleet-search', 'fleet-docview', 'fleet-pill'])
    return all.filter((u: any) => !FLEET_TYPES.has(u.type))
  }, [])
  const licenseKey = 'tldraw-2027-01-19/WyJhUGMwcWRBayIsWyIqLnF0bTI4NS5naXRodWIuaW8iXSw5LCIyMDI3LTAxLTE5Il0.Hq9z1V8oTLsZKgpB0pI3o/RXCoLOsh5Go7Co53YGqHNmtEO9Lv/iuyBPzwQwlxQoREjwkkFbpflOOPmQMwvQSQ'

  if (!mainEditor || !doc) {
    return (
      <div style={{ width: w, height: h, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.3, fontSize: 11 }}>
        No document
      </div>
    )
  }

  const errorHeaderH = 22

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
            <button
              className="fleet-layout-btn"
              style={{ marginLeft: 'auto' }}
              onPointerUp={(e: any) => { e.stopPropagation(); setShowSources(false) }}
              title="Back"
            >←</button>
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
          title="Configure sources"
        >⊛</button>
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
              onPointerUp={(e: any) => {
                e.stopPropagation()
                if (!mainEditor || !bounds) return
                const vp = mainEditor.getViewportPageBounds()
                mainEditor.centerOnPoint(
                  { x: vp.x + vp.w / 2, y: bounds.y + bounds.h / 2 },
                  { animation: { duration: 300 } }
                )
              }}
              title="Go to location"
            >↗</button>
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
        style={{ height: currentError ? h - errorHeaderH : h }}
      >
        {bounds && mainEditor ? (
          <CanvasClipPanel
            mainEditor={mainEditor}
            bounds={bounds}
            shapeUtils={shapeUtils}
            tools={[]}
            licenseKey={licenseKey}
            panelWidth={w}
            maxHeightFraction={1}
            readOnly
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

/**
 * DocViewPortal — renders a CanvasClipPanel via React portal outside the
 * tldraw tree, positioned to overlay the shape's screen location.
 * This avoids the nested-tldraw crash (React error #300).
 */
export function DocViewPortal({
  mainEditor, bounds, shapeUtils, licenseKey, panelWidth, panelHeight: _panelHeight, shapeId, editor: _editor,
}: {
  mainEditor: Editor
  bounds: ClipBounds
  shapeUtils: any[]
  licenseKey: string
  panelWidth: number
  panelHeight: number
  shapeId: string
  editor: Editor
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const el = document.createElement('div')
    el.className = 'fleet-docview-portal'
    el.style.position = 'fixed'
    el.style.zIndex = '99999'
    el.style.pointerEvents = 'none'
    document.body.appendChild(el)
    containerRef.current = el
    return () => { el.remove(); containerRef.current = null }
  }, [])

  useEffect(() => {
    const update = () => {
      const shapeEl = document.querySelector(`[data-shape-id="${shapeId}"]`)
      if (!shapeEl) return
      const bodyEl = shapeEl.querySelector('.fleet-docview-body')
      if (!bodyEl) return
      const rect = bodyEl.getBoundingClientRect()
      setPos({ x: rect.left, y: rect.top })
      if (containerRef.current) {
        containerRef.current.style.left = rect.left + 'px'
        containerRef.current.style.top = rect.top + 'px'
        containerRef.current.style.width = rect.width + 'px'
        containerRef.current.style.height = rect.height + 'px'
        containerRef.current.style.pointerEvents = isSelected ? 'none' : 'auto'
      }
    }
    update()
    const interval = setInterval(update, 500)
    return () => clearInterval(interval)
  }, [shapeId, isSelected])

  if (!containerRef.current || !pos) return null

  return createPortal(
    <CanvasClipPanel
      mainEditor={mainEditor}
      bounds={bounds}
      shapeUtils={shapeUtils}
      tools={[]}
      licenseKey={licenseKey}
      panelWidth={panelWidth}
      maxHeightFraction={1}
      readOnly
    />,
    containerRef.current,
  )
}
