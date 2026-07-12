import {
  createShapeId,
  getIndicesBetween,
  react,
  sortByIndex,
} from 'tldraw'
import type { TLShapePartial, Editor, TLShape, TLShapeId } from 'tldraw'
import { getSvgText, setSvgText, svgViewBoxStore, anchorIndex, setChangeHighlights, dismissAllChanges, getPageUrl, setPageRenderHash, setBuiltPageCount } from './stores'
import { resolvAnchor, pdfToCanvas, type SourceAnchor } from './synctexAnchor'
import { extractTextFromSvgAsync, type PageTextData } from './TextSelectionLayer'
import { currentDocumentInfo, setCurrentDocumentInfo, createSvgDocumentLayout, createHtmlDocumentFromPageInfo, type SvgDocument } from './svgDocumentLoader'
import { createSvgShapes, createHtmlShapes, createSlidesShapes, createImageShapes } from './loaders/createShapes'
import { anchorShape } from './anchorCluster'
import { snapHighlighterToText, restoreHighlightsFromShapes, showSourceContextCardForShape } from './highlighterSnap'
import { log } from './logger'
import { processHighlightFeedback } from './highlightFeedback'
import { processRibbonHighlight, isInRibbonZone, clearLineYIndexCache, remapRibbonSegments, initRibbon, setupRibbonEraser } from './ribbonInteraction'
import { showTranscriptionToast } from './transcriptionToast'
import { captureSnapshot } from './snapshotStore'
import { diffWords, extractFlatWords } from './wordDiff'
import { setupDiffOverlays, setupDiffHoverEffect, setupDiffReviewEffect } from './diffHelpers'
import { getViewerId } from './useYjsSync'
import { htmlPageReloadUrl } from './html-page-navigation-helpers'
import {
  getVisibilityMode, subscribeVisibility,
  isDraft, subscribeDrafts, addDraft, getDraftHovering, subscribeDraftHovering, isDraftMode,
} from './annotationVisibility'
// getRole import removed (unused)
import { cleanupHtmlShapeData } from './shapes/HtmlPageShape'
import { applyHtmlSelectionToHighlight } from './htmlSelection'

export type ReloadResult = {
  failedPages: number[]
  remapResult?: { failed: number; total: number }
}

/**
 * Remap annotations with source anchors to their new positions
 * Called after document SVGs are loaded/updated
 */
export async function remapAnnotations(
  editor: Editor,
  docName: string,
  pages: Array<{ bounds: { x: number, y: number, width: number, height: number }, width: number, height: number }>
): Promise<{ failed: number; total: number }> {
  const allShapes = editor.getCurrentPageShapes()

  // Find shapes with source anchors. Exclude understanding-line shapes —
  // they have their own remap path (remapUnderstandingLines).
  const anchored = allShapes.filter(shape => {
    if ((shape.type as string) === 'understanding-line') return false
    const meta = shape.meta as { sourceAnchor?: SourceAnchor }
    return meta?.sourceAnchor?.file && meta?.sourceAnchor?.line
  })

  if (anchored.length === 0) return { failed: 0, total: 0 }

  console.log(`[SyncTeX] Remapping ${anchored.length} anchored annotations...`)

  // Group by clusterId — clustered shapes move as a unit (same delta),
  // solo shapes (math notes) position directly from the anchor.
  const clusters = new Map<string, TLShape[]>()
  const solo: TLShape[] = []

  for (const shape of anchored) {
    const cid = (shape.meta as any).clusterId as string | undefined
    if (cid) {
      if (!clusters.has(cid)) clusters.set(cid, [])
      clusters.get(cid)!.push(shape)
    } else {
      solo.push(shape)
    }
  }

  const updates: TLShapePartial[] = []

  // Solo shapes (math notes): resolve anchor, update Y only.
  // Synctex x varies between builds (nearby-line fallback, display-math offsets), causing
  // horizontal drift that is confusing and not meaningful for note placement.
  for (const shape of solo) {
    const anchor = (shape.meta as any).sourceAnchor as SourceAnchor
    try {
      const pdfPos = await resolvAnchor(docName, anchor)
      if (!pdfPos) continue
      const canvasPos = pdfToCanvas(pdfPos.page, pdfPos.x, pdfPos.y, pages)
      if (!canvasPos) continue

      const newY = canvasPos.y - 100
      const dy = Math.abs(shape.y - newY)
      if (dy > 1) {
        updates.push({
          id: shape.id,
          type: shape.type,
          x: shape.x,
          y: newY,
        })
      }
    } catch (e) {
      console.warn(`[SyncTeX] Error resolving anchor:`, e)
    }
  }

  // Clustered shapes: resolve anchor once, compute delta, apply to all
  for (const [cid, shapes] of clusters) {
    const anchor = (shapes[0].meta as any).sourceAnchor as SourceAnchor
    const oldAnchorX = (shapes[0].meta as any).anchorCanvasX as number
    const oldAnchorY = (shapes[0].meta as any).anchorCanvasY as number

    if (oldAnchorX == null || oldAnchorY == null) continue

    try {
      const pdfPos = await resolvAnchor(docName, anchor)
      if (!pdfPos) continue
      const canvasPos = pdfToCanvas(pdfPos.page, pdfPos.x, pdfPos.y, pages)
      if (!canvasPos) continue

      const deltaX = canvasPos.x - oldAnchorX
      const deltaY = canvasPos.y - oldAnchorY

      if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) continue

      for (const shape of shapes) {
        updates.push({
          id: shape.id,
          type: shape.type,
          x: shape.x + deltaX,
          y: shape.y + deltaY,
          meta: {
            ...shape.meta,
            anchorCanvasX: canvasPos.x,
            anchorCanvasY: canvasPos.y,
          },
        })
      }

      console.log(`[SyncTeX] Cluster ${cid}: ${shapes.length} shapes moved by (${deltaX.toFixed(1)}, ${deltaY.toFixed(1)})`)
    } catch (e) {
      console.warn(`[SyncTeX] Error resolving cluster anchor:`, e)
    }
  }

  if (updates.length > 0) {
    console.log(`[SyncTeX] Applying ${updates.length} position updates`)
    editor.updateShapes(updates)
  }

  const total = anchored.length
  const failed = total - updates.length
  return { failed: Math.max(0, failed), total }
}

/** Diff old vs new page text using shared word-level diff. */
function diffTextLines(
  oldData: PageTextData,
  newData: PageTextData,
): { y: number; height: number }[] {
  return diffWords(extractFlatWords(oldData.lines), newData.lines)
}

/** Short build hash currently in the doc-version sentinel (the Built version), or null. */
function currentBuiltHash(editor?: Editor | null): string | null {
  const ed = editor || (window as any).__tldraw_editor__
  if (!ed) return null
  const s = ed.store.get('shape:doc-version--sentinel' as TLShapeId)
  const h = (s as any)?.props?.commitHash
  return h && h !== 'unknown' ? String(h).slice(0, 7) : null
}

/** Record that a page shape now shows the pixels from the current build. */
function stampRenderHash(shapeId: string, editor?: Editor | null) {
  const h = currentBuiltHash(editor)
  if (h) setPageRenderHash(shapeId, h)
}

/** Process a single fetched SVG page: parse viewBox, index anchors, push to store. */
function processPage(
  page: SvgDocument['pages'][number],
  svgText: string,
) {
  const parser = new DOMParser()
  const svgDoc = parser.parseFromString(svgText, 'image/svg+xml')
  const svgEl = svgDoc.querySelector('svg')
  if (svgEl) {
    const vb = svgEl.getAttribute('viewBox')
    if (vb) {
      const parts = vb.split(/\s+/).map(Number)
      if (parts.length === 4) {
        svgViewBoxStore.set(page.shapeId, { minX: parts[0], minY: parts[1], width: parts[2], height: parts[3] })
      }
    }
  }
  const views = svgDoc.querySelectorAll('view')
  for (const view of views) {
    const id = view.getAttribute('id')
    if (id) {
      anchorIndex.set(id, {
        pageShapeId: page.shapeId,
        viewBox: view.getAttribute('viewBox') || undefined,
      })
    }
  }

  // Populate reactive SVG text store — triggers component re-render immediately
  setSvgText(page.shapeId, svgText)
  stampRenderHash(page.shapeId)

  return svgDoc
}

/** Fetch a single SVG page, process it immediately, return parsed doc for text extraction. */
async function fetchPage(
  page: SvgDocument['pages'][number],
  basePath: string,
  index: number,
): Promise<{ index: number; svgDoc: Document } | null> {
  const pageBasePath = page.targetBasePath || basePath
  const pageNum = page.pageInTarget || (index + 1)
  const url = `${pageBasePath}page-${pageNum}.svg`
  try {
    let resp = await fetch(url)
    if (!resp.ok) {
      // Retry once after 1s — page may still be building
      await new Promise(r => setTimeout(r, 1000))
      resp = await fetch(`${pageBasePath}page-${pageNum}.svg?t=${Date.now()}`)
      if (!resp.ok) return null
    }
    const svgText = await resp.text()
    const svgDoc = processPage(page, svgText)
    return { index, svgDoc }
  } catch {
    return null
  }
}

/**
 * Fetch SVG pages with viewport-priority loading.
 * Pages visible on initial load are fetched first for fast first-paint,
 * then remaining pages load in parallel.
 * Text extraction is deferred to idle time after all pages render.
 */
export async function fetchSvgPagesAsync(
  editor: Editor,
  document: SvgDocument,
) {
  const basePath = document.basePath || `${import.meta.env.BASE_URL || '/'}docs/${document.name}/`
  const pages = document.pages
  // At load, the laid-out page set is the build's page set.
  setBuiltPageCount(pages.length)

  // Determine which pages are visible in the initial viewport.
  // Fetch those first for fast first-paint, then the rest in parallel.
  const vp = editor.getViewportScreenBounds()
  const cam = editor.getCamera()
  const viewHeight = vp.h / cam.z
  const viewTop = -cam.y
  const viewBottom = viewTop + viewHeight

  const priorityIndices: number[] = []
  const deferredIndices: number[] = []
  for (let i = 0; i < pages.length; i++) {
    const b = pages[i].bounds
    const pageBottom = b.y + b.height
    if (b.y < viewBottom && pageBottom > viewTop) {
      priorityIndices.push(i)
    } else {
      deferredIndices.push(i)
    }
  }
  // Always include at least one page beyond visible for smooth scrolling
  if (deferredIndices.length > 0 && priorityIndices.length > 0) {
    priorityIndices.push(deferredIndices.shift()!)
  }

  console.log(`[FetchAsync] Loading ${pages.length} pages (${priorityIndices.length} priority, ${deferredIndices.length} deferred)`)

  // Phase 1: fetch priority pages — visible content appears ASAP
  const svgDocs: Array<{ index: number; svgDoc: Document }> = []
  const priorityResults = await Promise.all(
    priorityIndices.map(i => fetchPage(pages[i], basePath, i))
  )
  for (const r of priorityResults) {
    if (r) svgDocs.push(r)
  }

  console.log(`[FetchAsync] ${svgDocs.length} priority pages rendered`)

  // Phase 2: fetch remaining pages in parallel
  if (deferredIndices.length > 0) {
    const deferredResults = await Promise.all(
      deferredIndices.map(i => fetchPage(pages[i], basePath, i))
    )
    for (const r of deferredResults) {
      if (r) svgDocs.push(r)
    }
  }

  console.log(`[FetchAsync] ${svgDocs.length}/${pages.length} pages rendered (${anchorIndex.size} hyperref anchors)`)

  // Defer text extraction to idle time — not needed for visual rendering,
  // only for text selection overlay. Process in page order.
  svgDocs.sort((a, b) => a.index - b.index)
  for (const { index, svgDoc } of svgDocs) {
    await new Promise(r => requestAnimationFrame(r))
    pages[index].textData = await extractTextFromSvgAsync(svgDoc)
  }

  console.log(`[FetchAsync] Text extraction complete for ${svgDocs.length} pages`)
}

// Generation counter for reloadPages — prevents interleaved concurrent reloads
let reloadGeneration = 0

type HtmlPageShapeRecord = {
  id: TLShapeId
  typeName: 'shape'
  type: 'html-page'
  props: {
    url?: string
    w?: number
    h?: number
    source?: string
  }
}

function isHtmlPageShapeRecord(record: unknown): record is HtmlPageShapeRecord {
  if (!record || typeof record !== 'object') return false
  const candidate = record as { typeName?: unknown; type?: unknown; props?: unknown }
  return candidate.typeName === 'shape' && candidate.type === 'html-page' && !!candidate.props && typeof candidate.props === 'object'
}

function putHtmlPageShapeRecord(editor: Editor, shape: HtmlPageShapeRecord) {
  // tldraw's Editor type is compiled against its built-in shape union, while
  // this app registers html-page at runtime. Keep the cast at that API boundary.
  editor.store.put([shape as unknown as Parameters<Editor['store']['put']>[0][number]])
}

async function reloadHtmlPages(editor: Editor, document: SvgDocument): Promise<ReloadResult> {
  const timestamp = Date.now()
  const basePath = document.basePath || `${import.meta.env.BASE_URL || '/'}docs/${document.name}/`

  try {
    const res = await fetch(`${basePath}page-info.json?t=${timestamp}`)
    if (!res.ok) throw new Error(`page-info.json returned ${res.status}`)
    const pageInfos = await res.json()
    const fresh = createHtmlDocumentFromPageInfo(document.name, basePath, pageInfos)
    document.pages.length = 0
    document.pages.push(...fresh.pages)
    document.basePath = basePath
    createHtmlShapes(editor, document)
  } catch (e) {
    console.warn('[Reload] HTML page-info refresh failed:', (e as Error).message)
  }

  const pageShapeIds = new Set(document.pages.map(page => page.shapeId))
  let refreshed = 0
  const records: unknown[] = editor.store.allRecords()
  for (const record of records) {
    if (!isHtmlPageShapeRecord(record)) continue
    const shape = record
    if (!pageShapeIds.has(shape.id)) continue
    const currentUrl = shape.props.url
    if (!currentUrl) continue

    putHtmlPageShapeRecord(editor, {
      ...shape,
      props: {
        ...shape.props,
        url: htmlPageReloadUrl(currentUrl, timestamp),
      },
    })
    refreshed += 1
  }

  console.log(`[Reload] Refreshed ${refreshed} html-page iframe(s)`)
  return { failedPages: [] }
}

/**
 * Markdown parts (notes/scratch) attached to a non-html/markdown project —
 * e.g. a LaTeX project's scratch columns. They render through the exact same
 * markdown renderer and html-page shape machinery as a markdown project's
 * own columns, on their own TLDraw page — separate from this document's SVG
 * pages, which createSvgShapes owns exclusively. Best-effort and self-
 * correcting: a project with no parts yet just 404s and no-ops.
 */
async function refreshSvgProjectParts(editor: Editor, document: SvgDocument) {
  const basePath = document.basePath || `${import.meta.env.BASE_URL || '/'}docs/${document.name}/`
  // Distinct namespace from the main document's own page/shape ids — the
  // main document already owns `${name}-page-N`; parts must never collide
  // with that, and must never land on the main document's default TLDraw
  // page (reuseDefaultPage: false).
  const partsName = `${document.name}--parts`
  try {
    const res = await fetch(`${basePath}page-info.json?t=${Date.now()}`)
    if (!res.ok) return
    const pageInfos = await res.json()
    if (!Array.isArray(pageInfos) || pageInfos.length === 0) return
    const partsDoc = createHtmlDocumentFromPageInfo(partsName, basePath, pageInfos)
    document.partPages = partsDoc.pages
    createHtmlShapes(editor, { ...document, name: partsName, pages: partsDoc.pages, format: 'html' }, { reuseDefaultPage: false })
  } catch (e) {
    console.warn('[Parts] refresh failed:', (e as Error).message)
  }
}

/**
 * Re-fetch SVG pages and hot-swap their TLDraw assets.
 * Called when a reload signal arrives from the MCP server after a rebuild.
 */
export async function reloadPages(
  editor: Editor,
  document: SvgDocument,
  pageNumbers: number[] | null, // null = all pages
): Promise<ReloadResult> {
  if (document.format === 'html' || document.format === 'markdown') return reloadHtmlPages(editor, document)

  // Markdown parts attached to this project — independent of whatever this
  // document's own reload does below (own try/catch, never blocks it).
  void refreshSvgProjectParts(editor, document)

  // Hot-reload is LaTeX-specific (re-fetch SVGs after rebuild)
  if (document.format === 'png' || document.format === 'diff') return { failedPages: [] }

  const gen = ++reloadGeneration

  // On a full reload the page COUNT may have changed — e.g. the author added an
  // \input section and the doc grew. reloadPages was handed the layout captured
  // at mount; without refreshing it, shapes for the new pages are never created
  // and the viewer wedges on the stale layout (showing the last old page on
  // repeat). Re-fetch the count and, if it changed, rebuild the layout and
  // reconcile the page shapes (create new, drop removed) before fetching SVGs.
  if (pageNumbers === null && document.format !== 'slides') {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(document.name)}`)
      if (res.ok) {
        const cfg = await res.json()
        const newCount: number = cfg.pages ?? document.pages.length
        if (newCount > 0) setBuiltPageCount(newCount)
        if (newCount > 0 && newCount !== document.pages.length) {
          const docBasePath = document.basePath || `${import.meta.env.BASE_URL || '/'}docs/${document.name}/`
          const targets = cfg.targets?.map((t: any) => ({
            name: t.texBase,
            title: String(t.texBase).replace(/_/g, ' '),
            pages: t.pages,
            basePath: docBasePath,
          }))
          const fresh = createSvgDocumentLayout(document.name, newCount, docBasePath, targets)
          // Mutate the live layout object in place so every reader — this reload,
          // remapAnnotations below, and future reloads — sees the new page set.
          document.pages.length = 0
          document.pages.push(...fresh.pages)
          document.targets = fresh.targets
          createSvgShapes(editor, document)
          // Keep the synctex/anchoring snapshot in step with the new page set.
          setCurrentDocumentInfo({
            name: document.name,
            pages: document.pages.map(p => ({
              bounds: { x: p.bounds.x, y: p.bounds.y, width: p.bounds.width, height: p.bounds.height },
              width: p.width,
              height: p.height,
            })),
          })
          console.log(`[Reload] Page count changed (→ ${newCount}); rebuilt layout and reconciled page shapes`)
        }
      }
    } catch (e) {
      console.warn('[Reload] page-count refresh failed:', (e as Error).message)
    }
  }

  const basePath = document.basePath || `${import.meta.env.BASE_URL || '/'}docs/${document.name}/`
  const pages = document.pages
  let indices: number[]
  if (pageNumbers) {
    indices = pageNumbers.map(n => n - 1).filter(i => i >= 0 && i < pages.length)
  } else {
    // Full reload — only fetch pages in/near the viewport
    const vp = editor.getViewportScreenBounds()
    const cam = editor.getCamera()
    const viewTop = -cam.y
    const viewBottom = viewTop + vp.h / cam.z
    const bufferH = pages[0]?.bounds.height ?? 1035
    indices = []
    for (let i = 0; i < pages.length; i++) {
      const b = pages[i].bounds
      if (b.y + b.height > viewTop - bufferH * 2 && b.y < viewBottom + bufferH * 2) {
        indices.push(i)
      }
    }
  }

  if (indices.length === 0) return { failedPages: [] }

  console.log(`[Reload] Fetching ${indices.length} page(s): ${indices.map(i => i + 1).join(', ')}`)

  const timestamp = Date.now()

  // Fetch SVGs in parallel with cache-bust
  const results = await Promise.all(
    indices.map(async (i) => {
      const page = pages[i]
      const storedUrl = getPageUrl(i)
      const pageBasePath = page.targetBasePath || basePath
      const pageNum = page.pageInTarget || (i + 1)
      const url = storedUrl ? `${storedUrl}?t=${timestamp}` : `${pageBasePath}page-${pageNum}.svg?t=${timestamp}`
      try {
        const resp = await fetch(url)
        if (!resp.ok) {
          console.warn(`[Reload] Failed to fetch page ${i + 1}: ${resp.status}`)
          return null
        }
        return { index: i, svgText: await resp.text() }
      } catch (e) {
        console.warn(`[Reload] Error fetching page ${i + 1}:`, e)
        return null
      }
    })
  )

  // Superseded by a newer reload — discard these results
  if (gen !== reloadGeneration) {
    console.log('[Reload] Superseded by newer reload, discarding')
    return { failedPages: [] }
  }

  // Track which pages failed to fetch
  const failedPages: number[] = []
  for (let i = 0; i < results.length; i++) {
    if (!results[i]) failedPages.push(indices[i] + 1)
  }

  // Save old SVG text + text data before overwriting (for change detection)
  const oldSvgTextMap = new Map<number, string | undefined>()
  const oldTextDataMap = new Map<number, PageTextData | null | undefined>()
  for (const result of results) {
    if (!result) continue
    oldSvgTextMap.set(result.index, getSvgText(pages[result.index].shapeId))
    oldTextDataMap.set(result.index, pages[result.index].textData)
  }

  // Capture pre-rebuild text into snapshot store (pages[].textData is still the old text)
  captureSnapshot(pages, Date.now())

  // Process and hot-swap each fetched page
  for (const result of results) {
    if (!result) continue
    const { index, svgText } = result
    const page = pages[index]

    // Skip if SVG content is identical (stale reload signal, no actual rebuild)
    const oldSvg = getSvgText(page.shapeId)
    if (oldSvg === svgText) continue

    // Rebuild anchor index and viewBox for this page
    const parser = new DOMParser()
    const svgDoc = parser.parseFromString(svgText, 'image/svg+xml')
    const svgEl = svgDoc.querySelector('svg')
    if (svgEl) {
      const vb = svgEl.getAttribute('viewBox')
      if (vb) {
        const parts = vb.split(/\s+/).map(Number)
        if (parts.length === 4) {
          svgViewBoxStore.set(page.shapeId, { minX: parts[0], minY: parts[1], width: parts[2], height: parts[3] })
        }
      }
    }
    const views = svgDoc.querySelectorAll('view')
    for (const view of views) {
      const id = view.getAttribute('id')
      if (id) {
        anchorIndex.set(id, {
          pageShapeId: page.shapeId,
          viewBox: view.getAttribute('viewBox') || undefined,
        })
      }
    }

    // For image shapes (PNG format), update the asset directly
    const shape = editor.getShape(page.shapeId)
    if (shape && shape.type === 'image') {
      const dataUrl = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgText)))
      const asset = editor.getAsset(page.assetId)
      if (asset && asset.type === 'image') {
        editor.updateAssets([{
          ...asset,
          props: { ...asset.props, src: dataUrl },
        }])
        console.log(`[Reload] Updated asset for page ${index + 1}`)
      }
    }

    // Re-extract text for selection overlay
    page.textData = await extractTextFromSvgAsync(svgDoc)

    // Detect changed text regions by diffing old vs new.
    // Skip if the raw SVG content is identical (stale reload signal, no actual rebuild).
    const oldSvgText = oldSvgTextMap.get(index)
    const oldTextData = oldTextDataMap.get(index)
    const svgContentChanged = oldSvgText !== undefined && oldSvgText !== svgText
    if (svgContentChanged && oldTextData && page.textData) {
      const regions = diffTextLines(oldTextData, page.textData)
      setChangeHighlights(page.shapeId, regions)
      if (regions.length > 0) {
        console.log(`[Reload] Page ${index + 1}: ${regions.length} changed region(s)`)
        // Auto-dismiss after 3s — don't make the user stare at blue
        setTimeout(() => dismissAllChanges(), 3000)
      }
    }

    // Update reactive SVG text store — triggers component re-render
    setSvgText(page.shapeId, svgText)
    stampRenderHash(page.shapeId, editor)
    console.log(`[Reload] Updated svg-page for page ${index + 1}`)
  }

  // After a full reload, remap annotations and ribbon shapes
  let remapResult: { failed: number; total: number } | undefined
  if (!pageNumbers) {
    if (currentDocumentInfo) {
      remapResult = await remapAnnotations(editor, currentDocumentInfo.name, currentDocumentInfo.pages)
    }
    // Phase 2: clear stale synctex cache and reposition understanding-line shapes.
    // (diff/png formats already returned early above, so no format check needed)
    clearLineYIndexCache(document.name)
    await remapRibbonSegments(editor, document.name, document.pages)
    await initRibbon(editor, document.name, document.pages)
  }

  console.log(`[Reload] Done — ${indices.length} page(s) updated`)
  return { failedPages, remapResult }
}

/**
 * Parse hyperref anchor ID into a display label.
 * e.g. "equation.2.28" → { type: "equation", displayLabel: "Eq. (2.28)" }
 */
export function anchorIdToLabel(anchorId: string): { type: string; displayLabel: string } {
  const dotIdx = anchorId.indexOf('.')
  if (dotIdx < 0) return { type: anchorId, displayLabel: anchorId }

  const rawType = anchorId.substring(0, dotIdx).toLowerCase()
  const number = anchorId.substring(dotIdx + 1)

  const typeMap: Record<string, string> = {
    equation: 'Eq.',
    theorem: 'Theorem',
    lemma: 'Lemma',
    proposition: 'Proposition',
    corollary: 'Corollary',
    definition: 'Definition',
    remark: 'Remark',
    example: 'Example',
    section: '§',
    subsection: '§',
    subsubsection: '§',
    appendix: 'Appendix',
    figure: 'Figure',
    table: 'Table',
    footnote: 'Footnote',
    hfootnote: 'Footnote',
    item: 'Item',
  }

  const displayType = typeMap[rawType] || (rawType.charAt(0).toUpperCase() + rawType.slice(1))

  if (rawType === 'equation') {
    return { type: 'equation', displayLabel: `${displayType} (${number})` }
  }
  return { type: rawType, displayLabel: `${displayType} ${number}` }
}

export function setupSvgEditor(editor: Editor, document: SvgDocument): {
  shapeIdSet: Set<TLShapeId>
  shapeIds: TLShapeId[]
  updateBounds: (bounds: any) => void
  ensurePagesAtBottom: () => void
} {
  // Create page shapes if they don't already exist (from Yjs sync)
  if (document.format === 'html' || document.format === 'markdown') {
    createHtmlShapes(editor, document)
  } else if (document.format === 'slides') {
    createSlidesShapes(editor, document)
  } else if (document.format === 'png') {
    createImageShapes(editor, document)
  } else {
    createSvgShapes(editor, document)
  }

  // Markdown parts (scratch/notes) attached to this project, if any — not
  // html/markdown format's own concern (those already include parts in
  // `document.pages` via page-info.json).
  if (document.format !== 'html' && document.format !== 'markdown') {
    void refreshSvgProjectParts(editor, document)
  }

  // Set up diff layout: old page opacity, highlight overlays
  // Check for existing diff shapes (from Yjs sync) by looking for the first highlight ID
  const diffExtraShapeIds: TLShapeId[] = []
  if (document.diffLayout) {
    const firstHlId = createShapeId(`${document.name}-diff-hl-0`)
    const hasDiffShapes = !!editor.getShape(firstHlId)
    if (!hasDiffShapes) {
      setupDiffOverlays(editor, document, diffExtraShapeIds)
    }
    // Always set up hover + review effects (work whether shapes came from creation or Yjs sync)
    setupDiffHoverEffect(editor, document)
    setupDiffReviewEffect(editor, document)
  }

  const shapeIds = [
    ...document.pages.map((page) => page.shapeId),
    ...diffExtraShapeIds,
  ]
  const shapeIdSet = new Set(shapeIds)

  // Don't let the user unlock the pages
  editor.sideEffects.registerBeforeChangeHandler('shape', (prev, next) => {
    if (!shapeIdSet.has(next.id)) return next
    if (next.isLocked) return next
    return { ...prev, isLocked: true }
  })

  // Clean up global maps when html-page shapes are deleted
  editor.store.listen(({ changes }) => {
    for (const shape of Object.values(changes.removed) as any[]) {
      if (shape?.typeName === 'shape' && shape?.type === 'html-page') {
        cleanupHtmlShapeData(shape.id)
      }
      // File-backed note deleted: drop its backing-file watch so the daemon stops
      // watching a file no note references. Skip if another note still backs it.
      if (shape?.typeName === 'shape' && shape?.type === 'math-note' && shape?.props?.backingFile) {
        const filePath = shape.props.backingFile
        const stillUsed = editor.getCurrentPageShapes().some(
          (s: any) => s.type === 'math-note' && s.props?.backingFile === filePath
        )
        if (!stillUsed) {
          fetch('/api/backing-file-unregister', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filePath, docName: document.name }),
          }).catch(e => log.warn('backing', 'unregister failed', { error: String(e?.message || e) }))
        }
      }
    }
  }, { scope: 'document' })

  // Initialize the single ribbon shape + eraser support
  const ribbonEnabled = document.format !== 'diff' && document.format !== 'png' && document.format !== 'html' &&
      document.format !== 'slides' && document.format !== 'markdown'
  if (ribbonEnabled) {
    void initRibbon(editor, document.name, document.pages)
    setupRibbonEraser(editor, document.name, document.pages)
  }

  // Make sure the shapes are below any of the other shapes
  function makeSureShapesAreAtBottom() {
    const shapes = [...shapeIdSet]
      .map((id) => editor.getShape(id))
      .filter((s): s is TLShape => s !== undefined)
      .sort(sortByIndex)
    if (shapes.length === 0) return

    const pageId = editor.getCurrentPageId()
    const siblings = editor.getSortedChildIdsForParent(pageId)
    const currentBottomShapes = siblings
      .slice(0, shapes.length)
      .map((id) => editor.getShape(id)!)

    if (currentBottomShapes.every((shape, i) => shape?.id === shapes[i]?.id)) return

    const otherSiblings = siblings.filter((id) => !shapeIdSet.has(id))
    if (otherSiblings.length === 0) return

    const bottomSibling = otherSiblings[0]
    const bottomShape = editor.getShape(bottomSibling)
    if (!bottomShape) return

    const lowestIndex = bottomShape.index
    const indexes = getIndicesBetween(undefined, lowestIndex, shapes.length)

    editor.updateShapes(
      shapes.map((shape, i) => ({
        id: shape.id,
        type: shape.type,
        isLocked: true,
        index: indexes[i],
      }))
    )
  }

  makeSureShapesAreAtBottom()
  // Only re-sort when a NEW shape is created (and only if it's not one of our page shapes).
  // Skip the change handler entirely — page shapes are locked and can't move, so z-order
  // only needs fixing when new user shapes (notes, drawings) appear.
  editor.sideEffects.registerAfterCreateHandler('shape', (shape, source) => {
    if (!shapeIdSet.has(shape.id)) {
      makeSureShapesAreAtBottom()
      // Stamp creation time + authorId (if not already set by server/MCP).
      // In viewer mode, also stamp draft:true — shapes sync normally but are
      // hidden from presenter until published. (The old remove+mergeRemoteChanges
      // approach fought @tldraw/sync's rebase protocol and shapes disappeared.)
      if (source === 'user' && !shape.meta?.createdAt) {
        const isViewerDraft = isDraftMode()
        editor.store.update(shape.id, (s: any) => ({
          ...s,
          meta: {
            ...s.meta,
            createdAt: Date.now(),
            authorId: getViewerId(),
            ...(isViewerDraft ? { draft: true } : {}),
          },
        }))
        if (isViewerDraft) addDraft(shape.id as any)
      }
      // Anchor user-created shapes to source lines (fire-and-forget)
      anchorShape(editor, shape)
      // Magic highlighter: snap highlight strokes to text
      // Shape is created on pointer-down with no segments. Wait for the stroke
      // to complete (user lifts pen), then snap. We detect completion by watching
      // for the editing shape to clear (user finishes the stroke).
      if (shape.type === 'highlight' && source === 'user') {
        // Wait for pen lift by polling editor.inputs.isPointing.
        // editor.on('event', pointer_up) doesn't fire during highlight.drawing state
        // because TLDraw's state machine consumes the event first.
        // isPointing is TLDraw's own reactive state — no event interception needed.
        let done = false

        const processShape = () => {
          if (done) return
          done = true
          const s = editor.getShape(shape.id as any)
          if (!s) { log.warn('outline-hl', 'processShape: shape gone'); return }
          const bounds = editor.getShapePageBounds(shape.id as any)
          log.info('outline-hl', 'processShape', { color: (s.props as any)?.color, w: bounds?.width, h: bounds?.height })
          if (!bounds || (bounds.width < 5 && bounds.height < 10)) { log.warn('outline-hl', 'processShape: too small', { w: bounds?.width, h: bounds?.height }); return }
          // Ribbon zone: highlight drawn in left margin → update understanding lines
          if (document.format !== 'diff' && isInRibbonZone(editor, shape.id as any)) {
            processRibbonHighlight(editor, shape.id as any, document.name, document.pages)
            return
          }
          // Outline highlighter (light-violet): snapHighlighterToText branches
          // internally to build a clause-outline sticky note instead of a mark.
          // Skip agent-feedback processing — it's not a review annotation.
          if ((s.props as any).color === 'light-violet') {
            if (applyHtmlSelectionToHighlight(editor, shape.id)) {
              processHighlightFeedback(editor, shape.id, document.name)
              return
            }
            snapHighlighterToText(editor, shape.id, document.name, document.targets)
            return
          }
          if (applyHtmlSelectionToHighlight(editor, shape.id)) {
            processHighlightFeedback(editor, shape.id, document.name)
            return
          }
          snapHighlighterToText(editor, shape.id, document.name, document.targets)
          processHighlightFeedback(editor, shape.id, document.name)
        }

        const tryProcess = () => {
          if (done) return
          const toolPath = editor.root.getPath()
          if (toolPath.includes('.drawing')) {
            setTimeout(tryProcess, 100)
            return
          }
          processShape()
        }

        // Wait 300ms (shape geometry settles), then poll until stroke completes
        setTimeout(tryProcess, 300)
        // Safety fallback: process after 5s regardless
        setTimeout(() => { if (!done) processShape() }, 5000)
      }
    }
  })

  // Slider zone guard: cancel highlight/draw tool when pointer_down is in the slider zone.
  // This prevents strokes from starting when the user interacts with the ghost slider.
  const SLIDER_ZONE_WIDTH = 250
  editor.on('event', (event: any) => {
    if (event.name !== 'pointer_down' || event.type !== 'pointer') return
    if (!event.point) return
    const w = window.innerWidth
    const h = window.innerHeight
    const inZone = event.point.x >= w - SLIDER_ZONE_WIDTH && event.point.y >= h * 0.1 && event.point.y <= h * 0.9
    if (!inZone) return
    const tool = editor.getCurrentToolId()
    if (tool === 'highlight' || tool === 'draw' || tool === 'eraser') {
      editor.cancel()
    }
  })

  // Re-saturate addressed highlights on tap/click.
  // When a highlight has meta.addressed = true, clicking it re-activates it
  // (sets addressed = false, restores opacity) so the agent retries.
  editor.on('event', (event) => {
    if (event.name !== 'pointer_up' || event.type !== 'pointer') return
    const selectedIds = editor.getSelectedShapeIds()
    if (selectedIds.length !== 1) return
    const shape = editor.getShape(selectedIds[0])
    if (!shape || shape.type !== 'highlight') return
    if (!shape.meta?.addressed) return
    // Re-saturate: clear addressed flag and restore opacity
    editor.store.update(shape.id, (s: any) => ({
      ...s,
      opacity: 1,
      meta: { ...s.meta, addressed: false },
    }))
  })

  // Drag-to-merge is handled by onTranslateEnd in MathNoteShapeUtil
  // (fires only on drop, not mid-drag)

  // Constrain the camera to the bounds of the pages
  let targetBounds = document.pages.reduce(
    (acc, page) => acc.union(page.bounds),
    document.pages[0].bounds.clone()
  )

  const isSlides = document.format === 'slides'

  function applyCameraBounds() {
    if (isSlides) {
      // Spatial slides: free camera within canvas bounds, initial zoom fits first slide
      editor.setCameraOptions({
        constraints: {
          bounds: targetBounds,
          padding: { x: 16, y: 16 },
          origin: { x: 0, y: 0 },
          initialZoom: 'default',
          baseZoom: 'default',
          behavior: 'free',
        },
      })
      // Center camera on first slide by width. Tall slides intentionally
      // overflow vertically instead of shrinking to fit a fixed viewport box.
      const first = document.pages[0]
      if (first) {
        const vp = editor.getViewportScreenBounds()
        const z = Math.min(1, vp.width / first.width)
        editor.setCamera({
          x: -first.bounds.x + (vp.width / z - first.width) / 2,
          y: -first.bounds.y,
          z,
        })
      }
    } else {
      editor.setCameraOptions({
        constraints: {
          bounds: targetBounds,
          padding: { x: 100, y: 50 },
          origin: { x: 0.5, y: 0 },
          initialZoom: 'fit-x-100',
          baseZoom: 'default',
          behavior: 'free',
        },
      })
      editor.setCamera(editor.getCamera(), { reset: true })
    }
  }

  let isMobile = editor.getViewportScreenBounds().width < 840

  react('update camera', () => {
    const isMobileNow = editor.getViewportScreenBounds().width < 840
    if (isMobileNow === isMobile) return
    isMobile = isMobileNow
    // Update constraints only — don't reset camera position (that would jump the user)
    editor.setCameraOptions({
      constraints: {
        bounds: targetBounds,
        padding: isSlides ? { x: 16, y: 16 } : { x: 100, y: 50 },
        origin: { x: isSlides ? 0 : 0.5, y: 0 },
        initialZoom: isSlides ? 'default' : 'fit-x-100',
        baseZoom: 'default',
        behavior: 'free',
      },
    })
  })

  applyCameraBounds()

  const result = {
    shapeIdSet,
    shapeIds,
    updateBounds: (newBounds: any) => {
      const prevW = targetBounds.w
      const cam = editor.getCamera()
      targetBounds = newBounds
      editor.setCameraOptions({
        constraints: {
          bounds: targetBounds,
          padding: isSlides ? { x: 16, y: 16 } : { x: 100, y: 50 },
          origin: { x: isSlides ? 0 : 0.5, y: 0 },
          initialZoom: isSlides ? 'default' : 'fit-x-100',
          baseZoom: 'default',
          behavior: 'free',
        },
      })
      if (newBounds.w > prevW * 1.2 && !isSlides) {
        editor.setCamera(editor.getCamera(), { reset: true })
      } else {
        editor.setCamera({ x: cam.x, y: cam.y, z: cam.z })
      }
    },
    ensurePagesAtBottom: makeSureShapesAreAtBottom,
  }

  // --- Dynamic visibility CSS engine ---
  // Targets foreign annotation shapes by [data-shape-id] — no store mutations, purely local.
  {
    const styleEl = window.document.createElement('style')
    window.document.head.appendChild(styleEl)

    function rebuildVisibilityCSS() {
      const visMode = getVisibilityMode()
      const allShapes = editor.getCurrentPageShapes()
      const localViewerId = getViewerId()

      // Own draft shapes: visible but dimmed so viewer knows they're unpublished
      const ownDraftSelectors = allShapes
        .filter(s => isDraft(s.id))
        .map(s => `[data-shape-id="${s.id}"]`)

      // Foreign draft shapes: always hidden regardless of visibility mode.
      // Shapes synced from server with meta.draft:true that belong to another viewer.
      const foreignDraftSelectors = allShapes
        .filter(s => !shapeIdSet.has(s.id))
        .filter(s => (s.meta as any)?.draft === true)
        .filter(s => (s.meta as any)?.authorId !== localViewerId)
        .filter(s => !isDraft(s.id))
        .map(s => `[data-shape-id="${s.id}"]`)

      let css = ''

      if (ownDraftSelectors.length > 0) {
        const hovering = getDraftHovering()
        css += `${ownDraftSelectors.join(',\n')} {
          opacity: ${hovering ? '1' : '0.6'} !important;
          filter: ${hovering ? 'none' : 'saturate(0.35)'} !important;
          transition: opacity 0.15s, filter 0.15s;
        }\n`
      }

      if (foreignDraftSelectors.length > 0) {
        css += `${foreignDraftSelectors.join(',\n')} {
          opacity: 0 !important;
          pointer-events: none !important;
        }\n`
      }

      if (visMode !== 'visible') {
        const opacity = visMode === 'faint' ? '0.07' : '0'
        const foreignSelectors = allShapes
          .filter(s => !shapeIdSet.has(s.id))
          .filter(s => (s.meta as any)?.authorId !== localViewerId)
          .filter(s => !isDraft(s.id))
          .filter(s => (s.meta as any)?.draft !== true)
          .map(s => `[data-shape-id="${s.id}"]`)

        if (foreignSelectors.length > 0) {
          css += `${foreignSelectors.join(',\n')} {
            opacity: ${opacity} !important;
            pointer-events: none !important;
            transition: opacity 0.3s;
          }\n`
        }
      }

      styleEl.textContent = css
    }

    void subscribeVisibility(rebuildVisibilityCSS)
    void subscribeDrafts(rebuildVisibilityCSS)
    void subscribeDraftHovering(rebuildVisibilityCSS)
    let rebuildTimer: ReturnType<typeof setTimeout>
    const debouncedRebuild = () => {
      clearTimeout(rebuildTimer)
      rebuildTimer = setTimeout(rebuildVisibilityCSS, 100)
    }
    void editor.store.listen(debouncedRebuild, { scope: 'document' })
    rebuildVisibilityCSS()
    // Note: cleanup not strictly needed (editor outlives this setup)
  }

  // Restore magic highlights from persisted metadata shapes
  setTimeout(() => restoreHighlightsFromShapes(editor), 1000)

  // Hover glow: tint text when hovering a highlight shape in select mode.
  // Uses store.listen on pointer scope to detect hoveredShapeId changes.
  {
    let glowCleanup: (() => void) | null = null
    let glowShapeId: string | null = null
    let cleanupTimer: ReturnType<typeof setTimeout> | null = null
    editor.store.listen(() => {
      try {
        // If cursor is over the source-context card, ignore hover changes
        // entirely. TLDraw keeps hover-testing for shapes underneath the card
        // (svg-page, other highlights), and any non-null hoveredId would
        // otherwise tear the card down out from under the user's cursor.
        // The card's own mouseleave (attached at card creation below) handles
        // cleanup when the cursor actually leaves it.
        if (globalThis.document.querySelector('.hl-source-card:hover')) return
        const hoveredId = editor.getHoveredShapeId()
        const id = hoveredId ?? null
        if (id === glowShapeId) return
        // Bridge zone: delay cleanup so cursor can move to the card
        if (!id && glowCleanup) {
          glowShapeId = null // prevent subsequent fires from resetting the timer
          if (cleanupTimer) clearTimeout(cleanupTimer)
          cleanupTimer = setTimeout(() => {
            // Check if cursor is over the card (use globalThis.document — `document` is the SvgDocument parameter)
            const card = globalThis.document.querySelector('.hl-source-card:hover')
            if (card) {
              // Card is hovered — keep it alive, listen for card mouseleave
              const onLeave = () => {
                card.removeEventListener('mouseleave', onLeave)
                if (glowCleanup) { glowCleanup(); glowCleanup = null }
                glowShapeId = null
              }
              card.addEventListener('mouseleave', onLeave)
              return
            }
            if (glowCleanup) { glowCleanup(); glowCleanup = null }
            glowShapeId = null
          }, 300)
          return
        }
        if (cleanupTimer) { clearTimeout(cleanupTimer); cleanupTimer = null }
        if (glowCleanup) { glowCleanup(); glowCleanup = null }
        glowShapeId = id
        if (id) {
          const shape = editor.getShape(id)
          if (shape?.type === 'highlight') {
            // Delay showing the source context card to avoid accidental triggers
            const hoverTimer = setTimeout(() => {
              // Re-check that we're still hovering this shape
              if (editor.getHoveredShapeId() !== id) return
              const cardOff = showSourceContextCardForShape(editor, id)
              // Wire the card's own mouseleave to glowCleanup, so the card
              // dies when the cursor actually leaves it — independent of
              // TLDraw hover state. This is the canonical dismissal path
              // once the card is shown; the bridge timer below only matters
              // for the case where the cursor exits the highlight without
              // ever reaching the card.
              const cardEl = globalThis.document.querySelector('.hl-source-card') as HTMLElement | null
              if (cardEl) {
                const onCardLeave = () => {
                  cardEl.removeEventListener('mouseleave', onCardLeave)
                  if (glowCleanup) { glowCleanup(); glowCleanup = null }
                  glowShapeId = null
                }
                cardEl.addEventListener('mouseleave', onCardLeave)
              }
              glowCleanup = () => { cardOff?.() }
            }, 500)
            glowCleanup = () => { clearTimeout(hoverTimer) }
          }
          // Show transcription toast on hover for recognized draw shapes
          if (shape?.type === 'draw' && (shape.meta as any)?.transcription) {
            glowCleanup = showTranscriptionToast(editor, shape)
          }
        }
      } catch { /* editor not ready */ }
    }, { source: 'all', scope: 'session' })
  }

  return result
}
