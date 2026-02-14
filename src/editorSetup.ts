import {
  createShapeId,
  getIndicesBetween,
  react,
  sortByIndex,
} from 'tldraw'
import type { TLImageShape, TLShapePartial, Editor, TLShape, TLShapeId } from 'tldraw'
import { svgTextStore, svgViewBoxStore, anchorIndex, setChangeHighlights } from './SvgPageShape'
import { resolvAnchor, pdfToCanvas, type SourceAnchor } from './synctexAnchor'
import { extractTextFromSvgAsync, type PageTextData } from './TextSelectionLayer'
import { currentDocumentInfo, type SvgDocument } from './svgDocumentLoader'
import { captureSnapshot } from './snapshotStore'
import { diffWords, extractFlatWords } from './wordDiff'
import { setupDiffOverlays, setupDiffHoverEffect, setupDiffReviewEffect } from './diffHelpers'

/**
 * Remap annotations with source anchors to their new positions
 * Called after document SVGs are loaded/updated
 */
export async function remapAnnotations(
  editor: Editor,
  docName: string,
  pages: Array<{ bounds: { x: number, y: number, width: number, height: number }, width: number, height: number }>
) {
  const allShapes = editor.getCurrentPageShapes()

  // Debug: log all shapes and their meta
  console.log(`[SyncTeX] Total shapes: ${allShapes.length}`)
  console.log(`[SyncTeX] All shapes:`, allShapes.map(s => ({ id: s.id, type: s.type, hasMeta: !!s.meta, metaKeys: Object.keys(s.meta || {}) })))

  // Find shapes with source anchors
  const anchored = allShapes.filter(shape => {
    const meta = shape.meta as { sourceAnchor?: SourceAnchor }
    return meta?.sourceAnchor?.file && meta?.sourceAnchor?.line
  })

  if (anchored.length === 0) {
    console.log('[SyncTeX] No anchored annotations to remap')
    return
  }

  console.log(`[SyncTeX] Remapping ${anchored.length} anchored annotations...`)

  // Resolve each anchor and update position
  const updates: Array<{ id: TLShapeId, x: number, y: number }> = []

  for (const shape of anchored) {
    const meta = shape.meta as unknown as { sourceAnchor: SourceAnchor }
    const anchor = meta.sourceAnchor

    try {
      // Get new PDF position from synctex
      const pdfPos = await resolvAnchor(docName, anchor)
      if (!pdfPos) {
        console.warn(`[SyncTeX] Could not resolve anchor for ${anchor.file}:${anchor.line}`)
        continue
      }

      // Convert to canvas coordinates
      const canvasPos = pdfToCanvas(pdfPos.page, pdfPos.x, pdfPos.y, pages)
      if (!canvasPos) {
        console.warn(`[SyncTeX] Could not convert PDF pos to canvas for page ${pdfPos.page}`)
        continue
      }

      // Only update if position actually changed
      const dx = Math.abs(shape.x - (canvasPos.x - 100))
      const dy = Math.abs(shape.y - (canvasPos.y - 100))
      if (dx > 1 || dy > 1) {
        updates.push({
          id: shape.id,
          x: canvasPos.x - 100, // Offset for note centering (matches MathNoteTool)
          y: canvasPos.y - 100,
        })
        console.log(`[SyncTeX] Moving ${shape.id} to (${canvasPos.x}, ${canvasPos.y}) from ${anchor.file}:${anchor.line}`)
      }
    } catch (e) {
      console.warn(`[SyncTeX] Error resolving anchor:`, e)
    }
  }

  if (updates.length > 0) {
    console.log(`[SyncTeX] Applying ${updates.length} position updates`)
    editor.updateShapes(updates.map(u => ({
      id: u.id,
      type: 'math-note' as const,
      x: u.x,
      y: u.y,
    })) as any)
  }
}

/** Diff old vs new page text using shared word-level diff. */
function diffTextLines(
  oldData: PageTextData,
  newData: PageTextData,
): { y: number; height: number }[] {
  return diffWords(extractFlatWords(oldData.lines), newData.lines)
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
) {
  // Hot-reload is LaTeX-specific (re-fetch SVGs after rebuild)
  if (document.format === 'png' || document.format === 'diff') return

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
    return
  }

  // Save old SVG text + text data before overwriting (for change detection)
  const oldSvgTextMap = new Map<number, string | undefined>()
  const oldTextDataMap = new Map<number, PageTextData | null | undefined>()
  for (const result of results) {
    if (!result) continue
    oldSvgTextMap.set(result.index, svgTextStore.get(pages[result.index].shapeId))
    oldTextDataMap.set(result.index, pages[result.index].textData)
  }

  // Capture pre-rebuild text into snapshot store (pages[].textData is still the old text)
  captureSnapshot(pages, Date.now())

  // Process and hot-swap each fetched page
  for (const result of results) {
    if (!result) continue
    const { index, svgText } = result
    const page = pages[index]

    // Update the SVG text store for inline svg-page shapes
    svgTextStore.set(page.shapeId, svgText)

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

    // For svg-page shapes, bump version to trigger re-render
    const shape = editor.getShape(page.shapeId)
    if (shape && (shape.type as string) === 'svg-page') {
      editor.updateShape({
        id: shape.id,
        type: 'svg-page' as any,
        props: { version: ((shape as any).props.version || 0) + 1 },
      })
      console.log(`[Reload] Updated svg-page for page ${index + 1}`)
    } else if (shape && shape.type === 'image') {
      // Fallback for image shapes (PNG format)
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
      }
    }
  }

  // After a full reload, remap annotations
  if (!pageNumbers) {
    if (currentDocumentInfo) {
      await remapAnnotations(editor, currentDocumentInfo.name, currentDocumentInfo.pages)
    }
  }

  console.log(`[Reload] Done — ${indices.length} page(s) updated`)
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
  const hasPages = document.format === 'html'
    ? existingShapes.some(s => (s.type as string) === 'html-page')
    : document.format === 'png'
    ? editor.getAssets().some(a => a.props && 'name' in a.props && a.props.name === 'svg-page')
    : existingShapes.some(s => (s.type as string) === 'svg-page')

  if (!hasPages) {
    if (document.format === 'html') {
      // Create html-page custom shapes (no assets needed)
      editor.createShapes(
        document.pages.map((page) => ({
          id: page.shapeId,
          type: 'html-page' as any,
          x: page.bounds.x,
          y: page.bounds.y,
          isLocked: true,
          props: {
            w: page.bounds.w,
            h: page.bounds.h,
            url: page.src,
          },
        }))
      )
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
  editor.sideEffects.registerAfterCreateHandler('shape', makeSureShapesAreAtBottom)
  editor.sideEffects.registerAfterChangeHandler('shape', makeSureShapesAreAtBottom)

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

  return {
    shapeIdSet,
    shapeIds,
    updateBounds: (newBounds: any) => {
      targetBounds = newBounds
      applyCameraBounds()
    },
    ensurePagesAtBottom: makeSureShapesAreAtBottom,
  }
}
