/**
 * Format-specific shape creation for editorSetup.
 * Each function checks if shapes already exist (from Yjs sync),
 * creates them if not, and returns the set of page shape IDs.
 */
import type { Editor, TLShapeId, TLPageId } from 'tldraw'
import type { SvgDocument } from './types'

/**
 * Create SVG page shapes (custom svg-page type with inline rendering).
 * Also handles diff documents (SVG + old page overlay).
 */
export function createSvgShapes(editor: Editor, document: SvgDocument): boolean {
  // Remove stale svg-page shapes not in the current document layout
  // (handles single-target → multi-target transitions where shape IDs change)
  const expectedIds = new Set(document.pages.map(p => p.shapeId))
  const stalePages = editor.getCurrentPageShapes()
    .filter(s => (s.type as string) === 'svg-page' && !expectedIds.has(s.id))
  if (stalePages.length > 0) {
    editor.deleteShapes(stalePages.map(s => s.id))
  }

  // Find which pages are missing (snapshot may have partial set)
  const missingPages = document.pages.filter((page) => !editor.getShape(page.shapeId))
  if (missingPages.length > 0) {
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
  }

  // Pages must always render below annotation shapes — send to back every time
  // so notes/highlights placed after initial load stay on top.
  const allPageIds = document.pages.map(p => p.shapeId).filter(id => editor.getShape(id))
  if (allPageIds.length > 0) editor.sendToBack(allPageIds)

  return missingPages.length === 0
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
 * All slides on a single TLDraw page, laid out horizontally.
 * Each slide is an html-page shape with a URL containing _tldaH/_tldaV params.
 * Camera navigation moves between slides; RevealJS handles fragment stepping.
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
 * Create zoomable image page shapes (PNG format).
 * Uses ZoomableImageShape — a chromeless mini-editor with independent
 * pan/zoom so the user can pinch-zoom into screenshots without moving
 * the outer canvas.
 */
export function createImageShapes(editor: Editor, document: SvgDocument): boolean {
  // Check for existing zoomable-image shapes (from sync snapshot)
  const hasPages = editor.getCurrentPageShapes().some(
    s => (s.type as string) === 'zoomable-image' || s.type === 'image'
  )
  if (hasPages) return true

  editor.createShapes(
    document.pages.map(
      (page, i) => ({
        id: page.shapeId,
        type: 'zoomable-image' as any,
        x: page.bounds.x,
        y: page.bounds.y,
        isLocked: true,
        opacity: document.diffLayout?.oldPageIndices.has(i) ? 0.5 : 1,
        props: {
          w: page.bounds.w,
          h: page.bounds.h,
          src: page.src,
          imageW: page.width,
          imageH: page.height,
        },
      })
    )
  )

  return false
}
