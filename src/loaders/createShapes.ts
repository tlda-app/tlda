/**
 * Format-specific shape creation for editorSetup.
 * Each function checks if shapes already exist (from Yjs sync),
 * creates them if not, and returns the set of page shape IDs.
 */
import type { Editor, TLPageId, TLShapeId } from 'tldraw'
import type { SvgDocument } from './types'

type HtmlPageShape = {
  id: TLShapeId
  type: 'html-page'
  typeName?: 'shape'
  parentId?: TLPageId
  x: number
  y: number
  isLocked?: boolean
  props: { w: number; h: number; url?: string }
} & Record<string, unknown>

function isHtmlPageShape(shape: unknown): shape is HtmlPageShape {
  return typeof shape === 'object' && shape !== null && 'type' in shape && shape.type === 'html-page'
}

type HtmlPageShapePartial = {
  id: TLShapeId
  type: 'html-page'
  parentId?: TLPageId
  x: number
  y: number
  isLocked: boolean
  props: { w: number; h: number; url: string }
}

function createHtmlPageShape(editor: Editor, shape: HtmlPageShapePartial) {
  // tldraw's Editor type is compiled against its built-in shape union, while
  // this app registers html-page via HtmlPageShapeUtil at runtime. Remove this
  // boundary cast if Editor becomes parameterized by app-registered shapes.
  editor.createShapes([shape as unknown as Parameters<Editor['createShapes']>[0][number]])
}

function putHtmlPageShape(editor: Editor, shape: HtmlPageShape) {
  // Same custom-shape boundary as createHtmlPageShape; this preserves the
  // existing shape record's parent/index/meta fields while updating deck props.
  editor.store.put([shape as unknown as Parameters<Editor['store']['put']>[0][number]])
}

function getAllHtmlPageShapes(editor: Editor): HtmlPageShape[] {
  return Object.values(editor.store.allRecords())
    .filter(record =>
      typeof record === 'object' &&
      record !== null &&
      (record as { typeName?: unknown }).typeName === 'shape' &&
      (record as { type?: unknown }).type === 'html-page'
    ) as unknown as HtmlPageShape[]
}

function sendDocumentPagesToBack(editor: Editor) {
  const ids = editor.getCurrentPageShapes()
    .filter(s =>
      (s.type as string) === 'svg-page' ||
      (s.type as string) === 'html-page' ||
      (s.type as string) === 'zoomable-image' ||
      s.type === 'image')
    .map(s => s.id)
  if (ids.length > 0) editor.sendToBack(ids)
}

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
  sendDocumentPagesToBack(editor)

  return missingPages.length === 0
}

/**
 * Create HTML page shapes with multipage TLDraw layout.
 * Each chapter gets its own TLDraw page. Handles migration from
 * old single-page format (reparents annotations to correct pages).
 */
export function createHtmlShapes(
  editor: Editor,
  document: SvgDocument,
  { reuseDefaultPage = true }: { reuseDefaultPage?: boolean } = {},
): boolean {
  const existingShapes = editor.getCurrentPageShapes()
  const allHtmlShapes = getAllHtmlPageShapes(editor)
  const expectedIds = new Set(document.pages.map(page => page.shapeId))
  let changed = false

  // Old format: shapes on single page — delete and recreate as multipage
  let annotationMigration: Array<{ noteId: TLShapeId; chapterIdx: number; relY: number }> | undefined
  const hasCurrentPageHtmlShapes = existingShapes.some(s => (s.type as string) === 'html-page')
  const hasOwnedHtmlShapes = allHtmlShapes.some(s => expectedIds.has(s.id))
  if (hasCurrentPageHtmlShapes && !hasOwnedHtmlShapes) {
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
    changed = true
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
  const defaultPageId = editor.getPages()[0]?.id || editor.getCurrentPageId()
  const pageIdMap = new Map<string, TLPageId>()

  for (let pi = 0; pi < pageIds.length; pi++) {
    const tlPageId = pageIds[pi]
    if (pi === 0 && reuseDefaultPage) {
      const firstPage = document.pages.find(p => p.tldrawPageId === tlPageId)
      if (firstPage?.tldrawPageName) {
        editor.renamePage(defaultPageId, firstPage.tldrawPageName)
      }
      pageIdMap.set(tlPageId, defaultPageId)
    } else {
      const newPageId = tlPageId as TLPageId
      const pageName = document.pages.find(p => p.tldrawPageId === tlPageId)?.tldrawPageName || `Chapter ${pi + 1}`
      if (!editor.getPages().some(page => page.id === newPageId)) {
        editor.createPage({ id: newPageId, name: pageName })
        changed = true
      }
      pageIdMap.set(tlPageId, newPageId)
    }
  }

  const ownedPrefix = `shape:${document.name}-page-`
  const staleHtmlShapes = getAllHtmlPageShapes(editor)
    .filter(shape => String(shape.id).startsWith(ownedPrefix) && !expectedIds.has(shape.id))
  if (staleHtmlShapes.length > 0) {
    editor.deleteShapes(staleHtmlShapes.map(shape => shape.id))
    changed = true
  }

  // Create or update shapes on their respective pages.
  for (const page of document.pages) {
    const targetPageId = page.tldrawPageId ? pageIdMap.get(page.tldrawPageId) : defaultPageId
    const existing = editor.getShape(page.shapeId) as HtmlPageShape | undefined
    if (!existing) {
      createHtmlPageShape(editor, {
        id: page.shapeId,
        type: 'html-page',
        parentId: targetPageId,
        x: page.bounds.x,
        y: page.bounds.y,
        isLocked: true,
        props: {
          w: page.bounds.w,
          h: page.bounds.h,
          url: page.src,
        },
      })
      changed = true
      continue
    }
    if (
      existing.parentId === targetPageId &&
      existing.x === page.bounds.x &&
      existing.y === page.bounds.y &&
      existing.isLocked === true &&
      existing.props?.w === page.bounds.w &&
      existing.props?.h === page.bounds.h &&
      existing.props?.url === page.src
    ) continue
    putHtmlPageShape(editor, {
      ...existing,
      parentId: targetPageId,
      x: page.bounds.x,
      y: page.bounds.y,
      isLocked: true,
      props: {
        ...existing.props,
        w: page.bounds.w,
        h: page.bounds.h,
        url: page.src,
      },
    })
    changed = true
  }

  sendDocumentPagesToBack(editor)

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

  return !changed
}

/**
 * Create slides shapes (reveal.js decks).
 * All slides on a single TLDraw page, laid out horizontally.
 * Each slide is an html-page shape with a URL containing _tldaH/_tldaV params.
 * Camera navigation moves between slides; RevealJS handles fragment stepping.
 */
export function createSlidesShapes(editor: Editor, document: SvgDocument): boolean {
  const existingShapes: unknown[] = editor.getCurrentPageShapes()
  const expectedIds = new Set(document.pages.map(p => p.shapeId))
  const staleSlidePages: HtmlPageShape[] = []
  for (const shape of existingShapes) {
    if (!isHtmlPageShape(shape) || expectedIds.has(shape.id)) continue
    const url = shape.props.url || ''
    if (url.includes('_tldaH=') || url.includes('_tldaDeck=1')) {
      staleSlidePages.push(shape)
    }
  }
  if (staleSlidePages.length > 0) {
    editor.store.remove(staleSlidePages.map(s => s.id))
  }

  let changed = staleSlidePages.length > 0
  for (const page of document.pages) {
    const shape: unknown = editor.getShape(page.shapeId)
    if (!shape) {
      const deckShape = {
        id: page.shapeId,
        type: 'html-page' as const,
        x: page.bounds.x,
        y: page.bounds.y,
        isLocked: true,
        props: {
          w: page.bounds.w,
          h: page.bounds.h,
          url: page.src,
        },
      } satisfies HtmlPageShapePartial
      createHtmlPageShape(editor, deckShape)
      changed = true
      continue
    }
    if (!isHtmlPageShape(shape)) continue
    if (
      shape.x === page.bounds.x &&
      shape.y === page.bounds.y &&
      shape.props?.w === page.bounds.w &&
      shape.props?.h === page.bounds.h &&
      shape.props?.url === page.src
    ) continue
    putHtmlPageShape(editor, {
      ...shape,
      x: page.bounds.x,
      y: page.bounds.y,
      isLocked: true,
      props: {
        ...shape.props,
        w: page.bounds.w,
        h: page.bounds.h,
        url: page.src,
      },
    })
    changed = true
  }

  if (!changed) {
    sendDocumentPagesToBack(editor)
    return true
  }
  sendDocumentPagesToBack(editor)
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
  if (hasPages) {
    sendDocumentPagesToBack(editor)
    return true
  }

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
  sendDocumentPagesToBack(editor)

  return false
}
