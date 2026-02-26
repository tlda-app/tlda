import {
  createShapeId,
  getIndicesBetween,
  react,
  sortByIndex,
} from 'tldraw'
import type { TLImageShape, TLShapePartial, Editor, TLShape, TLShapeId, TLPageId } from 'tldraw'
import { getSvgText, setSvgText, svgViewBoxStore, anchorIndex, setChangeHighlights, dismissAllChanges } from './stores'
import { resolvAnchor, pdfToCanvas, type SourceAnchor } from './synctexAnchor'
import { extractTextFromSvgAsync, type PageTextData } from './TextSelectionLayer'
import { currentDocumentInfo, type SvgDocument } from './svgDocumentLoader'
import { anchorShape } from './anchorCluster'
import { mergeTabs } from './noteThreading'
import { snapHighlighterToText, restoreHighlightsFromShapes, showGlow } from './highlighterSnap'
import { captureSnapshot } from './snapshotStore'
import { diffWords, extractFlatWords } from './wordDiff'
import { setupDiffOverlays, setupDiffHoverEffect, setupDiffReviewEffect } from './diffHelpers'

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

  // Find shapes with source anchors
  const anchored = allShapes.filter(shape => {
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

  // Solo shapes (math notes): resolve anchor, position directly
  for (const shape of solo) {
    const anchor = (shape.meta as any).sourceAnchor as SourceAnchor
    try {
      const pdfPos = await resolvAnchor(docName, anchor)
      if (!pdfPos) continue
      const canvasPos = pdfToCanvas(pdfPos.page, pdfPos.x, pdfPos.y, pages)
      if (!canvasPos) continue

      const newX = canvasPos.x - 100
      const newY = canvasPos.y - 100
      const dx = Math.abs(shape.x - newX)
      const dy = Math.abs(shape.y - newY)
      if (dx > 1 || dy > 1) {
        updates.push({
          id: shape.id,
          type: shape.type,
          x: newX,
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

  return svgDoc
}

/** Fetch a single SVG page, process it immediately, return parsed doc for text extraction. */
async function fetchPage(
  page: SvgDocument['pages'][number],
  basePath: string,
  index: number,
): Promise<{ index: number; svgDoc: Document } | null> {
  const url = `${basePath}page-${index + 1}.svg`
  try {
    let resp = await fetch(url)
    if (!resp.ok) {
      // Retry once after 1s — page may still be building
      await new Promise(r => setTimeout(r, 1000))
      resp = await fetch(`${basePath}page-${index + 1}.svg?t=${Date.now()}`)
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

  // Determine which pages are visible in the initial viewport.
  // Camera starts fit-x at the top (origin y=0), so estimate visible height
  // from the viewport bounds. Pad by 1 page to prefetch just beyond the fold.
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
    // Yield to the main thread between pages so interactions stays responsive
    await new Promise(r => requestAnimationFrame(r))
    pages[index].textData = await extractTextFromSvgAsync(svgDoc)
  }

  console.log(`[FetchAsync] Text extraction complete for ${svgDocs.length} pages`)
}

// Generation counter for reloadPages — prevents interleaved concurrent reloads
let reloadGeneration = 0

/**
 * Re-fetch SVG pages and hot-swap their TLDraw assets.
 * Called when a reload signal arrives from the MCP server after a rebuild.
 */
export async function reloadPages(
  editor: Editor,
  document: SvgDocument,
  pageNumbers: number[] | null, // null = all pages
): Promise<ReloadResult> {
  // Hot-reload is LaTeX-specific (re-fetch SVGs after rebuild)
  if (document.format === 'png' || document.format === 'diff') return { failedPages: [] }

  const gen = ++reloadGeneration

  const basePath = document.basePath || `${import.meta.env.BASE_URL || '/'}docs/${document.name}/`
  const pages = document.pages
  const indices = pageNumbers
    ? pageNumbers.map(n => n - 1).filter(i => i >= 0 && i < pages.length)
    : pages.map((_, i) => i)

  if (indices.length === 0) return

  console.log(`[Reload] Fetching ${indices.length} page(s): ${indices.map(i => i + 1).join(', ')}`)

  const timestamp = Date.now()

  // Fetch SVGs in parallel with cache-bust
  const results = await Promise.all(
    indices.map(async (i) => {
      const url = `${basePath}page-${i + 1}.svg?t=${timestamp}`
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
    console.log(`[Reload] Updated svg-page for page ${index + 1}`)
  }

  // After a full reload, remap annotations
  let remapResult: { failed: number; total: number } | undefined
  if (!pageNumbers) {
    if (currentDocumentInfo) {
      remapResult = await remapAnnotations(editor, currentDocumentInfo.name, currentDocumentInfo.pages)
    }
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
  // Check if page shapes already exist (from sync)
  const existingShapes = editor.getCurrentPageShapes()
  let hasPages: boolean
  if (document.format === 'html') {
    // For multipage HTML: check if TLDraw pages already exist (not just shapes on default page).
    // If shapes exist on the default page only (old single-page format), we need to migrate.
    const tlPages = editor.getPages()
    const hasMultiplePages = tlPages.length > 1
    const hasHtmlShapes = existingShapes.some(s => (s.type as string) === 'html-page')
    if (hasMultiplePages && hasHtmlShapes) {
      hasPages = true  // Already migrated to multipage
    } else if (hasHtmlShapes) {
      // Old format: shapes on single page. Delete them and recreate as multipage.
      // Preserve math-note annotations — we'll migrate them after creating new pages.
      const oldHtmlShapes = existingShapes.filter(s => (s.type as string) === 'html-page')
      const oldFigShapes = existingShapes.filter(s => (s.type as string) === 'svg-figure')
      // Record annotation positions relative to html-page shapes for migration
      const annotations = existingShapes.filter(s =>
        (s.type as string) === 'math-note' || s.type === 'note'
      )
      const annotationMigration = annotations.map(note => {
        // Find which old html-page shape this note is closest to (by Y position)
        let bestIdx = 0
        let bestDist = Infinity
        const sortedOld = [...oldHtmlShapes].sort((a, b) => a.y - b.y)
        for (let ci = 0; ci < sortedOld.length; ci++) {
          const dist = Math.abs(note.y - sortedOld[ci].y)
          if (dist < bestDist) { bestDist = dist; bestIdx = ci }
        }
        return { noteId: note.id, chapterIdx: bestIdx, relY: note.y - sortedOld[bestIdx].y }
      })
      // Delete old shapes
      editor.deleteShapes([...oldHtmlShapes.map(s => s.id), ...oldFigShapes.map(s => s.id)])
      // Store migration info for after page creation
      ;(editor as any).__annotationMigration = annotationMigration
      hasPages = false
    } else {
      hasPages = false
    }
  } else if (document.format === 'png') {
    hasPages = editor.getAssets().some(a => a.props && 'name' in a.props && a.props.name === 'svg-page')
  } else {
    hasPages = existingShapes.some(s => (s.type as string) === 'svg-page')
  }

  if (!hasPages) {
    if (document.format === 'html') {
      // Multipage HTML: create one TLDraw page per chapter, then shapes on each page.
      // Collect unique tldrawPageIds in order.
      const seenPages = new Set<string>()
      const pageIds: string[] = []
      for (const page of document.pages) {
        const pid = page.tldrawPageId
        if (pid && !seenPages.has(pid)) {
          seenPages.add(pid)
          pageIds.push(pid)
        }
      }

      // Create TLDraw pages (skip the default page — we'll use it for the first chapter)
      const defaultPageId = editor.getCurrentPageId()
      const pageIdMap = new Map<string, TLPageId>()

      for (let pi = 0; pi < pageIds.length; pi++) {
        const tlPageId = pageIds[pi]
        if (pi === 0) {
          // Reuse the default page for the first chapter
          // Rename it to the chapter name
          const firstPage = document.pages.find(p => p.tldrawPageId === tlPageId)
          if (firstPage?.tldrawPageName) {
            editor.renamePage(defaultPageId, firstPage.tldrawPageName)
          }
          pageIdMap.set(tlPageId, defaultPageId)
        } else {
          const newPageId = tlPageId as TLPageId
          const pageName = document.pages.find(p => p.tldrawPageId === tlPageId)?.tldrawPageName || `Chapter ${pi + 1}`
          editor.createPage({ id: newPageId, name: pageName })
          pageIdMap.set(tlPageId, newPageId)
        }
      }

      // Create shapes on their respective pages using parentId
      for (const page of document.pages) {
        const targetPageId = page.tldrawPageId ? pageIdMap.get(page.tldrawPageId) : defaultPageId
        editor.createShapes([{
          id: page.shapeId,
          type: 'html-page' as any,
          parentId: targetPageId,
          x: page.bounds.x,
          y: page.bounds.y,
          isLocked: true,
          props: {
            w: page.bounds.w,
            h: page.bounds.h,
            url: page.src,
          },
        }])
      }

      // Switch back to first page
      editor.setCurrentPage(defaultPageId)

      // Migrate annotations from old single-page format to multipage
      const migration = (editor as any).__annotationMigration as Array<{ noteId: TLShapeId; chapterIdx: number; relY: number }> | undefined
      if (migration?.length) {
        delete (editor as any).__annotationMigration
        for (const { noteId, chapterIdx } of migration) {
          const targetPage = document.pages[chapterIdx]
          const targetTlPageId = targetPage?.tldrawPageId ? pageIdMap.get(targetPage.tldrawPageId) : defaultPageId
          if (targetTlPageId) {
            editor.reparentShapes([noteId], targetTlPageId)
          }
        }
      }
    } else if (document.format === 'png') {
      // PNG pages: use image assets + shapes
      editor.createAssets(
        document.pages.map((page) => ({
          id: page.assetId,
          typeName: 'asset',
          type: 'image',
          meta: {},
          props: {
            w: page.width,
            h: page.height,
            mimeType: 'image/png',
            src: page.src,
            name: 'svg-page',
            isAnimated: false,
          },
        }))
      )

      editor.createShapes(
        document.pages.map(
          (page, i): TLShapePartial<TLImageShape> => ({
            id: page.shapeId,
            type: 'image',
            x: page.bounds.x,
            y: page.bounds.y,
            isLocked: true,
            opacity: document.diffLayout?.oldPageIndices.has(i) ? 0.5 : 1,
            props: {
              assetId: page.assetId,
              w: page.bounds.w,
              h: page.bounds.h,
            },
          })
        )
      )
    } else {
      // SVG pages: use inline svg-page custom shapes (hyperref links are clickable)
      editor.createShapes(
        document.pages.map((page, i) => ({
          id: page.shapeId,
          type: 'svg-page' as any,
          x: page.bounds.x,
          y: page.bounds.y,
          isLocked: true,
          opacity: document.diffLayout?.oldPageIndices.has(i) ? 0.5 : 1,
          props: {
            w: page.bounds.w,
            h: page.bounds.h,
            pageIndex: i,
          },
        }))
      )
    }
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
  editor.sideEffects.registerAfterCreateHandler('shape', (shape) => {
    if (!shapeIdSet.has(shape.id)) {
      makeSureShapesAreAtBottom()
      // Stamp creation time for temporal clustering (if not already set by server/MCP)
      if (!shape.meta?.createdAt) {
        editor.store.update(shape.id, (s: any) => ({
          ...s,
          meta: { ...s.meta, createdAt: Date.now() },
        }))
      }
      // Anchor user-created shapes to source lines (fire-and-forget)
      anchorShape(editor, shape)
      // Magic highlighter: snap highlight strokes to text
      // Shape is created on pointer-down with no segments. Wait for the stroke
      // to complete (user lifts pen), then snap. We detect completion by watching
      // for the editing shape to clear (user finishes the stroke).
      if (shape.type === 'highlight') {
        let attempts = 0
        const checkSnap = () => {
          attempts++
          if (attempts > 30) return // give up after 6s
          const s = editor.getShape(shape.id as any)
          if (!s) return
          // Check if user is still drawing (highlight tool is active and pointing)
          const currentTool = editor.getCurrentToolId()
          if (currentTool === 'highlight' && editor.inputs.isPointing) {
            setTimeout(checkSnap, 200)
            return
          }
          const bounds = editor.getShapePageBounds(shape.id as any)
          if (!bounds || bounds.width < 5) {
            setTimeout(checkSnap, 200)
            return
          }
          snapHighlighterToText(editor, shape.id)
        }
        setTimeout(checkSnap, 300)
      }
    }
  })

  // Drag-to-merge: when a math-note is dropped overlapping another, merge tabs
  editor.sideEffects.registerAfterChangeHandler('shape', (prev, next) => {
    if (next.type !== 'math-note') return
    if (shapeIdSet.has(next.id)) return
    if (prev.x === next.x && prev.y === next.y) return

    const allShapes = editor.getCurrentPageShapes()
    for (const other of allShapes) {
      if (other.id === next.id) continue
      if (other.type !== 'math-note') continue

      // Simple bounding box overlap
      const ow = (other.props as any).w || 200
      const oh = (other.props as any).h || 50
      const nw = (next.props as any).w || 200
      const nh = (next.props as any).h || 50

      const overlapX = next.x < other.x + ow && next.x + nw > other.x
      const overlapY = next.y < other.y + oh && next.y + nh > other.y

      if (overlapX && overlapY) {
        // Merge: dragged note's tabs merge into target
        setTimeout(() => mergeTabs(editor, next.id, other.id), 0)
        return
      }
    }
  })

  // Constrain the camera to the bounds of the pages
  let targetBounds = document.pages.reduce(
    (acc, page) => acc.union(page.bounds),
    document.pages[0].bounds.clone()
  )

  function applyCameraBounds() {
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

  let isMobile = editor.getViewportScreenBounds().width < 840

  react('update camera', () => {
    const isMobileNow = editor.getViewportScreenBounds().width < 840
    if (isMobileNow === isMobile) return
    isMobile = isMobileNow
    applyCameraBounds()
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
          padding: { x: 100, y: 50 },
          origin: { x: 0.5, y: 0 },
          initialZoom: 'fit-x-100',
          baseZoom: 'default',
          behavior: 'free',
        },
      })
      if (newBounds.w > prevW * 1.2) {
        // Bounds expanded significantly (overlay added) — refit to show both columns
        editor.setCamera(editor.getCamera(), { reset: true })
      } else {
        // Bounds narrowed or unchanged — preserve camera position
        editor.setCamera({ x: cam.x, y: cam.y, z: cam.z })
      }
    },
    ensurePagesAtBottom: makeSureShapesAreAtBottom,
  }

  // Restore magic highlights from persisted metadata shapes
  setTimeout(() => restoreHighlightsFromShapes(editor), 1000)

  // Hover glow: tint text when hovering a highlight shape in select mode.
  // Uses store.listen on pointer scope to detect hoveredShapeId changes.
  {
    let glowCleanup: (() => void) | null = null
    let glowShapeId: string | null = null
    editor.store.listen(() => {
      try {
        const hoveredId = editor.getHoveredShapeId()
        const id = hoveredId ?? null
        if (id === glowShapeId) return
        if (glowCleanup) { glowCleanup(); glowCleanup = null }
        glowShapeId = id
        if (id) {
          const shape = editor.getShape(id)
          if (shape?.type === 'highlight' && (shape.meta as any)?.glowRects) {
            glowCleanup = showGlow(editor, id)
          }
        }
      } catch { /* editor not ready */ }
    }, { source: 'all', scope: 'session' })
  }

  return result
}
