/**
 * Format-specific shape creation for editorSetup.
 * Each function checks if shapes already exist (from Yjs sync),
 * creates them if not, and returns the set of page shape IDs.
 */
import {
  createShapeId,
} from 'tldraw'
import type { TLImageShape, TLShapePartial, Editor, TLShapeId, TLPageId } from 'tldraw'
import type { SvgDocument } from './types'

/**
 * Create SVG page shapes (custom svg-page type with inline rendering).
 * Also handles diff documents (SVG + old page overlay).
 */
export function createSvgShapes(editor: Editor, document: SvgDocument): boolean {
  // Find which pages are missing (snapshot may have partial set)
  const missingPages = document.pages.filter((page) => !editor.getShape(page.shapeId))
  if (missingPages.length === 0) return true

  editor.createShapes(
    missingPages.map((page) => {
      const i = document.pages.indexOf(page)
      return {
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
      }
    })
  )
  return false
}

/**
 * Create HTML page shapes with multipage TLDraw layout.
 * Each chapter gets its own TLDraw page. Handles migration from
 * old single-page format (reparents annotations to correct pages).
 */
export function createHtmlShapes(editor: Editor, document: SvgDocument): boolean {
  const existingShapes = editor.getCurrentPageShapes()

  // Check if already migrated to multipage
  const tlPages = editor.getPages()
  const hasMultiplePages = tlPages.length > 1
  const hasHtmlShapes = existingShapes.some(s => (s.type as string) === 'html-page')

  if (hasMultiplePages && hasHtmlShapes) return true // already set up

  // Old format: shapes on single page — delete and recreate as multipage
  let annotationMigration: Array<{ noteId: TLShapeId; chapterIdx: number; relY: number }> | undefined
  if (hasHtmlShapes) {
    const oldHtmlShapes = existingShapes.filter(s => (s.type as string) === 'html-page')
    const oldFigShapes = existingShapes.filter(s => (s.type as string) === 'svg-figure')
    const annotations = existingShapes.filter(s =>
      (s.type as string) === 'math-note' || s.type === 'note'
    )
    annotationMigration = annotations.map(note => {
      let bestIdx = 0
      let bestDist = Infinity
      const sortedOld = [...oldHtmlShapes].sort((a, b) => a.y - b.y)
      for (let ci = 0; ci < sortedOld.length; ci++) {
        const dist = Math.abs(note.y - sortedOld[ci].y)
        if (dist < bestDist) { bestDist = dist; bestIdx = ci }
      }
      return { noteId: note.id, chapterIdx: bestIdx, relY: note.y - sortedOld[bestIdx].y }
    })
    editor.deleteShapes([...oldHtmlShapes.map(s => s.id), ...oldFigShapes.map(s => s.id)])
  } else if (hasHtmlShapes) {
    return true
  }

  // Collect unique tldrawPageIds in order
  const seenPages = new Set<string>()
  const pageIds: string[] = []
  for (const page of document.pages) {
    const pid = page.tldrawPageId
    if (pid && !seenPages.has(pid)) {
      seenPages.add(pid)
      pageIds.push(pid)
    }
  }

  // Create TLDraw pages (reuse default page for first chapter)
  const defaultPageId = editor.getCurrentPageId()
  const pageIdMap = new Map<string, TLPageId>()

  for (let pi = 0; pi < pageIds.length; pi++) {
    const tlPageId = pageIds[pi]
    if (pi === 0) {
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

  // Create shapes on their respective pages
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

  // Migrate annotations from old single-page format
  if (annotationMigration?.length) {
    for (const { noteId, chapterIdx } of annotationMigration) {
      const targetPage = document.pages[chapterIdx]
      const targetTlPageId = targetPage?.tldrawPageId ? pageIdMap.get(targetPage.tldrawPageId) : defaultPageId
      if (targetTlPageId) {
        editor.reparentShapes([noteId], targetTlPageId)
      }
    }
  }

  return false
}

/**
 * Create slides shapes (reveal.js decks).
 * All slides on a single TLDraw page, stacked vertically like SVG pages.
 * Each slide is an html-page shape with a URL containing _tldaSlide param.
 */
export function createSlidesShapes(editor: Editor, document: SvgDocument): boolean {
  const existingShapes = editor.getCurrentPageShapes()
  const hasHtmlShapes = existingShapes.some(s => (s.type as string) === 'html-page')
  if (hasHtmlShapes) return true

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
  return false
}

/**
 * Create PNG image page shapes (vestigial format).
 */
export function createImageShapes(editor: Editor, document: SvgDocument): boolean {
  const hasPages = editor.getAssets().some(a => a.props && 'name' in a.props && a.props.name === 'svg-page')
  if (hasPages) return true

  editor.createAssets(
    document.pages.map((page) => ({
      id: page.assetId,
      typeName: 'asset' as const,
      type: 'image' as const,
      meta: {},
      props: {
        w: page.width,
        h: page.height,
        mimeType: 'image/png' as const,
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

  return false
}
