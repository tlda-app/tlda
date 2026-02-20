/**
 * BuildErrorOverlay — displays build errors as text shapes on the canvas
 * to the right of the source lines where errors occur, with a CanvasClipPanel
 * to window into each error region.
 *
 * When build errors arrive via signal:build-status:
 * 1. Load synctex lookup to map error line numbers → canvas positions
 * 2. Create TLDraw text shapes positioned to the right of the page
 * 3. Show a CanvasClipPanel focused on the current error
 * 4. Nav buttons cycle through errors
 *
 * Shapes are cleaned up on successful build or when errors change.
 * Uses a deterministic ID prefix so stale shapes from Yjs persistence
 * are cleaned up on reconnect.
 */
import { useEffect, useMemo, useState, useCallback, useRef } from 'react'

import { createShapeId, toRichText } from 'tldraw'
import type { Editor, TLShapeId, TLAnyShapeUtilConstructor, TLStateNodeConstructor } from 'tldraw'
import { CanvasClipPanel, type ClipBounds } from './CanvasClipPanel'
import { loadLookup, type LookupEntry } from './synctexLookup'
import { pdfToCanvas } from './synctexAnchor'
import type { BuildError, BuildProgressSignal } from './useYjsSync'
import { onBuildProgressSignal } from './useYjsSync'
import type { DocContextValue } from './PanelContext'
import { openInEditor } from './texsync'
import './BuildErrorOverlay.css'

const ERROR_MARGIN_RIGHT = 20 // gap between page right edge and error text
const ERROR_TEXT_WIDTH = 400  // width of error text shapes
const ERROR_SHAPE_PREFIX = 'shape:build-error-'

interface ResolvedError {
  error: BuildError
  canvasX: number
  canvasY: number
  shapeId: TLShapeId
  page: number
}

interface BuildErrorOverlayProps {
  mainEditor: Editor
  errors: BuildError[]
  doc: DocContextValue
  shapeUtils: TLAnyShapeUtilConstructor[]
  tools: TLStateNodeConstructor[]
  licenseKey: string
}

/** Remove all build-error shapes (by prefix, plus stale locked text shapes from older versions) */
function cleanupAllErrorShapes(editor: Editor) {
  const toDelete = editor.getCurrentPageShapes()
    .filter(s => {
      // Match by deterministic prefix
      if (s.id.startsWith(ERROR_SHAPE_PREFIX)) return true
      // Also clean up stale shapes from before we used deterministic IDs:
      // locked text shapes positioned to the right of the page (x >= 800)
      if (s.type === 'text' && s.isLocked && s.x >= 800) return true
      return false
    })
    .map(s => s.id)
  if (toDelete.length > 0) {
    // Locked shapes can't be deleted via editor.deleteShape — use store directly
    editor.store.remove(toDelete as TLShapeId[])
  }
}

export function BuildErrorOverlay({
  mainEditor,
  errors,
  doc,
  shapeUtils,
  tools,
  licenseKey,
}: BuildErrorOverlayProps) {
  const [resolved, setResolved] = useState<ResolvedError[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [expanded, setExpanded] = useState(true)

  // Build progress tracking
  const [progress, setProgress] = useState<BuildProgressSignal | null>(null)
  const [progressVisible, setProgressVisible] = useState(false)
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return onBuildProgressSignal((signal) => {
      setProgress(signal)
      setProgressVisible(true)

      if (fadeTimer.current) {
        clearTimeout(fadeTimer.current)
        fadeTimer.current = null
      }

      if (signal.phase === 'done') {
        fadeTimer.current = setTimeout(() => {
          setProgressVisible(false)
          fadeTimer.current = null
        }, 4000)
      }
    })
  }, [])

  // Resolve error line numbers to canvas positions and create text shapes
  useEffect(() => {
    // Always clean up previous error shapes first (handles stale Yjs persistence)
    cleanupAllErrorShapes(mainEditor)

    if (errors.length === 0) {
      setResolved([])
      setActiveIndex(0)
      return
    }

    let cancelled = false

    async function resolveErrors() {
      const lookup = await loadLookup(doc.docName)
      if (cancelled || !lookup) return

      // Clean up again in case another invocation created shapes while we awaited
      cleanupAllErrorShapes(mainEditor)

      const newResolved: ResolvedError[] = []

      for (let i = 0; i < errors.length; i++) {
        const err = errors[i]
        if (!err.line) continue

        const entry = findNearestLine(lookup.lines, err.line, err.file)
        if (!entry) continue

        const canvas = pdfToCanvas(entry.page, entry.x, entry.y, doc.pages)
        if (!canvas) continue

        const pageBounds = doc.pages[entry.page - 1]?.bounds
        if (!pageBounds) continue

        // Position text to the right of the page
        const textX = pageBounds.x + pageBounds.width + ERROR_MARGIN_RIGHT
        const textY = canvas.y - 8 // slight upward offset to align with the line

        const msg = formatErrorMessage(err)
        const shapeId = `${ERROR_SHAPE_PREFIX}${i}` as TLShapeId

        mainEditor.createShape({
          id: shapeId,
          type: 'text',
          x: textX,
          y: textY,
          isLocked: true,
          props: {
            richText: toRichText(msg),
            font: 'mono',
            size: 's',
            color: 'red',
            w: ERROR_TEXT_WIDTH,
            autoSize: false,
          },
        })

        newResolved.push({
          error: err,
          canvasX: textX,
          canvasY: textY,
          shapeId,
          page: entry.page,
        })
      }

      if (!cancelled) {
        setResolved(newResolved)
        setActiveIndex(0)
      } else {
        // Effect was cancelled — clean up shapes we just created
        cleanupAllErrorShapes(mainEditor)
      }
    }

    resolveErrors()
    return () => {
      cancelled = true
      cleanupAllErrorShapes(mainEditor)
    }
  }, [errors, doc, mainEditor])

  // Compute clip bounds for the active error — sized to fit the text shape
  const bounds = useMemo((): ClipBounds | null => {
    const item = resolved[activeIndex]
    if (!item) return null

    const pageBounds = doc.pages[item.page - 1]?.bounds
    if (!pageBounds) return null

    // Use the actual shape bounds if available
    const shapeBounds = mainEditor.getShapePageBounds(item.shapeId)
    const shapeH = shapeBounds ? shapeBounds.h : 120
    const CONTEXT_ABOVE = 20
    const CONTEXT_BELOW = 20
    return {
      x: pageBounds.x + 50,
      y: item.canvasY - CONTEXT_ABOVE,
      w: pageBounds.width + ERROR_MARGIN_RIGHT + ERROR_TEXT_WIDTH - 20,
      h: shapeH + CONTEXT_ABOVE + CONTEXT_BELOW,
    }
  }, [resolved, activeIndex, doc, mainEditor])

  // Navigate to error on the main canvas
  const goToError = useCallback((idx: number) => {
    const item = resolved[idx]
    if (!item) return
    const pageBounds = doc.pages[item.page - 1]?.bounds
    const centerX = pageBounds ? pageBounds.x + pageBounds.width / 2 : item.canvasX
    mainEditor.centerOnPoint({ x: centerX, y: item.canvasY }, { animation: { duration: 300 } })
  }, [resolved, doc, mainEditor])

  const handlePrev = useCallback(() => {
    const next = (activeIndex - 1 + resolved.length) % resolved.length
    setActiveIndex(next)
    goToError(next)
  }, [activeIndex, resolved.length, goToError])

  const handleNext = useCallback(() => {
    const next = (activeIndex + 1) % resolved.length
    setActiveIndex(next)
    goToError(next)
  }, [activeIndex, resolved.length, goToError])

  // During active build phases, show progress pill (even if there are errors)
  const buildActive = progressVisible && progress &&
    (progress.phase === 'compiling' || progress.phase === 'converting' || progress.phase === 'hot')

  if (buildActive || resolved.length === 0) {
    if (!progressVisible || !progress) return null

    const { phase, detail } = progress
    let stage = ''
    switch (phase) {
      case 'compiling': stage = 'compiling'; break
      case 'converting': stage = 'converting'; break
      case 'hot': stage = 'patched'; break
      case 'done': stage = 'rebuilt'; break
      case 'failed': stage = 'failed'; break
    }

    return (
      <div
        className="build-progress-row"
        onPointerDown={e => e.stopPropagation()}
      >
        <span className="build-progress-pill">{stage}</span>
        {detail && <span className="build-progress-detail">{detail}</span>}
      </div>
    )
  }

  const active = resolved[activeIndex]
  const errorLabel = active.error.line ? `l.${active.error.line}` : 'Error'

  if (!expanded) {
    return (
      <div
        className="build-error-pill"
        onClick={() => setExpanded(true)}
        onPointerDown={e => e.stopPropagation()}
        onPointerUp={e => e.stopPropagation()}
        onTouchStart={e => e.stopPropagation()}
        onTouchEnd={e => e.stopPropagation()}
        title="Show build errors"
      >
        {resolved.length > 1 && (
          <button
            className="build-error-pill-nav"
            onClick={(e) => { e.stopPropagation(); handlePrev() }}
          >‹</button>
        )}
        <span className="build-error-pill-title">
          {resolved.length === 1 ? errorLabel : `${resolved.length} errors`}
        </span>
        {resolved.length > 1 && (
          <>
            <span className="build-error-pill-page">{errorLabel}</span>
            <button
              className="build-error-pill-nav"
              onClick={(e) => { e.stopPropagation(); handleNext() }}
            >›</button>
          </>
        )}
      </div>
    )
  }

  return (
    <CanvasClipPanel
      mainEditor={mainEditor}
      bounds={bounds}
      shapeUtils={shapeUtils}
      tools={tools}
      licenseKey={licenseKey}
      className="build-error-overlay"
    >
      <div className="build-error-label">
        {resolved.length > 1 && (
          <button className="build-error-nav" onClick={handlePrev} title="Previous error">
            ‹
          </button>
        )}
        <span className="build-error-title">
          {errorLabel}
          {active.error.file && <span className="build-error-file"> {active.error.file}</span>}
        </span>
        {resolved.length > 1 && (
          <>
            <span className="build-error-count">
              {activeIndex + 1}/{resolved.length}
            </span>
            <button className="build-error-nav" onClick={handleNext} title="Next error">
              ›
            </button>
          </>
        )}
        <button
          className="build-error-action"
          onClick={() => goToError(activeIndex)}
          title="Scroll to error"
        >
          ↗
        </button>
        {active.error.line && (
          <button
            className="build-error-action"
            onClick={() => openInEditor(doc.docName, active.error.file, active.error.line!)}
            title="Open in editor (texsync)"
          >
            ⌘
          </button>
        )}
        <button
          className="build-error-action"
          onClick={() => setExpanded(false)}
          title="Minimize"
        >
          ▾
        </button>
      </div>
    </CanvasClipPanel>
  )
}

/**
 * Find the nearest synctex lookup entry for a source line.
 * Exact match first, then search ±30 lines for the closest entry.
 */
function findNearestLine(
  lines: Record<string, LookupEntry>,
  line: number,
  file?: string,
): LookupEntry | null {
  // Try exact match
  const key = file ? `${file}:${line}` : String(line)
  if (lines[key]) return lines[key]
  if (lines[String(line)]) return lines[String(line)]

  // Search nearby lines (forward-biased since errors often occur before visible content)
  for (let offset = 1; offset <= 30; offset++) {
    const fwd = file ? `${file}:${line + offset}` : String(line + offset)
    const bwd = file ? `${file}:${line - offset}` : String(line - offset)
    if (lines[fwd]) return lines[fwd]
    if (lines[String(line + offset)]) return lines[String(line + offset)]
    if (lines[bwd]) return lines[bwd]
    if (lines[String(line - offset)]) return lines[String(line - offset)]
  }

  return null
}

function formatErrorMessage(err: BuildError): string {
  // Clean up LaTeX error message
  let cleaned = err.message.replace(/^!\s*/, '').trim()
  const msgLines = cleaned.split('\n')
  if (msgLines.length > 2) {
    const first = msgLines[0]
    const lLine = msgLines.find(l => /^l\.\d+/.test(l.trim()))
    cleaned = lLine ? `${first}\n${lLine.trim()}` : first
  }

  // Append source context with line numbers
  if (err.context?.length) {
    const maxLineNum = err.context[err.context.length - 1].line
    const pad = String(maxLineNum).length
    const contextStr = err.context.map(c => {
      const marker = c.line === err.errorLine ? '→' : ' '
      const num = String(c.line).padStart(pad)
      return `${marker}${num}  ${c.text}`
    }).join('\n')
    cleaned += '\n\n' + contextStr
  }

  return cleaned
}
