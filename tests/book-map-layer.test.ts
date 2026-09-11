import assert from 'node:assert/strict'
import test from 'node:test'

import { createHtmlDocumentFromPageInfo, type HtmlPageEntry } from '../src/loaders/htmlLoader'
import { pagesForView } from '../src/loaders/documentFormatRouting'
import { orphanedDocumentPageIds } from '../src/loaders/createShapes'

/**
 * project > map > doc. A map is one TLDraw page; a doc is a place on it. The
 * builder says which chapter a doc belongs to via `group`, and that is the only
 * thing the map layer reads.
 */

const chapter = (file: string, group?: string, extra: Partial<HtmlPageEntry> = {}): HtmlPageEntry => ({
  file: `${file}.html`,
  width: 800,
  height: 1200,
  title: file,
  ...(group ? { group } : {}),
  source: { type: 'project-source', format: 'qmd', file: `${file}.qmd` },
  ...extra,
})

test('a chapter and its deck are two docs on one map', () => {
  const document = createHtmlDocumentFromPageInfo('course', '/docs/course/', [
    chapter('ch-sampling', 'ch-sampling.qmd', { variant: 'chapter' }),
    chapter('ch-sampling-slides', 'ch-sampling.qmd', { variant: 'slides' }),
  ])

  assert.equal(document.pages.length, 2)
  assert.equal(document.pages[0].tldrawPageId, document.pages[1].tldrawPageId)
  // Side by side, which is what the chapter/deck pairing has always looked like.
  assert.equal(document.pages[0].bounds.x, 0)
  assert.ok(document.pages[1].bounds.x > 0)
})

test('a map is named after its chapter, never after the group id', () => {
  const document = createHtmlDocumentFromPageInfo('course', '/docs/course/', [
    chapter('intro', 'lectures/chapter-sampling.qmd', { title: 'Sampling', variant: 'chapter' }),
    chapter('deck', 'lectures/chapter-sampling.qmd', { title: 'Sampling — slides', variant: 'slides' }),
  ])

  assert.equal(document.pages[0].tldrawPageName, 'Sampling')
  assert.equal(document.pages[1].tldrawPageName, 'Sampling')
})

test("a chapter's map survives a reordering of the book's chapter list", () => {
  const one = chapter('a', 'a.qmd')
  const two = chapter('b', 'b.qmd')
  const forward = createHtmlDocumentFromPageInfo('course', '/docs/course/', [one, two])
  const reversed = createHtmlDocumentFromPageInfo('course', '/docs/course/', [two, one])

  const pageOf = (doc: typeof forward, file: string) =>
    doc.pages.find(page => page.src.includes(file))!.tldrawPageId

  assert.equal(pageOf(forward, 'a.html'), pageOf(reversed, 'a.html'))
  assert.equal(pageOf(forward, 'b.html'), pageOf(reversed, 'b.html'))
  // Including the chapter that moved into first position: a map-keyed document
  // claims no positional page, so there is no default-page slot to move into.
  assert.ok(!forward.pages.some(page => page.tldrawPageId === 'page:page'))
})

test('a deck paired with a chapter is not dropped from the map view', () => {
  const pages = [
    chapter('ch', 'ch.qmd', { variant: 'chapter' }),
    chapter('ch-slides', 'ch.qmd', { variant: 'slides' }),
  ]

  assert.equal(pagesForView(pages, 'html-pages').length, 2)
})

test('a paired deck does not renumber the chapters the ToC navigates by', () => {
  // toc.json numbers entries by position in the chapter list and
  // navigateToPage reads doc.pages[n - 1], so a deck must never land between
  // two chapters.
  const pages = [
    chapter('one', 'one.qmd', { variant: 'chapter' }),
    chapter('one-slides', 'one.qmd', { variant: 'slides' }),
    chapter('two', 'two.qmd', { variant: 'chapter' }),
  ]

  assert.deepEqual(
    pagesForView(pages, 'html-pages').map(page => page.file),
    ['one.html', 'two.html', 'one-slides.html'],
  )
})

test('a deck belonging to no chapter still opens only as a deck', () => {
  const pages = [
    chapter('ch', 'ch.qmd', { variant: 'chapter' }),
    chapter('standalone-slides', 'standalone-slides.qmd', { variant: 'slides' }),
  ]

  const view = pagesForView(pages, 'html-pages')
  assert.equal(view.length, 1)
  assert.equal(view[0].file, 'ch.html')
})

test('a document whose entries carry no group keeps its positional page ids', () => {
  // The whole of "nothing changes for any non-book project": no builder outside
  // the book path emits `group`, so every one of them lands here.
  const document = createHtmlDocumentFromPageInfo('notes', '/docs/notes/', [
    chapter('one'),
    chapter('two'),
    chapter('three'),
  ])

  assert.deepEqual(
    document.pages.map(page => page.tldrawPageId),
    ['page:page', 'page:notes-ch-1', 'page:notes-ch-2'],
  )
})

test('two group ids that slug alike do not become one map', () => {
  const document = createHtmlDocumentFromPageInfo('course', '/docs/course/', [
    chapter('first', 'a/b.qmd'),
    chapter('second', 'a-b.qmd'),
    chapter('third', 'a/b.qmd'),
  ])

  const [one, two, three] = document.pages.map(page => page.tldrawPageId)
  assert.notEqual(one, two)
  assert.equal(one, three)
})

/**
 * Migration. Re-keying a document's pages leaves its old ones behind empty, and
 * nothing else in the app deletes a TLDraw page.
 */

const sweep = (
  pageIds: string[],
  livePageIds: string[],
  nonEmpty: string[] = [],
) => orphanedDocumentPageIds({
  documentName: 'course',
  pageIds,
  livePageIds: new Set(livePageIds),
  isEmpty: pageId => !nonEmpty.includes(pageId),
})

test('the pages a re-keyed document left behind are swept', () => {
  assert.deepEqual(
    sweep(
      ['page:page', 'page:course-ch-1', 'page:course-map-a-qmd', 'page:course-map-b-qmd'],
      ['page:course-map-a-qmd', 'page:course-map-b-qmd'],
    ),
    ['page:page', 'page:course-ch-1'],
  )
})

test('a page holding anything at all is kept, document or not', () => {
  // The whole reason the zero-annotation window matters: once a page carries
  // someone's work, the migration must leave it alone.
  assert.deepEqual(
    sweep(
      ['page:page', 'page:course-ch-1', 'page:course-map-a-qmd'],
      ['page:course-map-a-qmd'],
      ['page:course-ch-1'],
    ),
    ['page:page'],
  )
})

test('the default page is swept only for a map-keyed document', () => {
  // Positional document: `page:page` is the page it is using, not an orphan,
  // even while one of its other pages genuinely is one.
  assert.deepEqual(
    sweep(
      ['page:page', 'page:course-ch-1', 'page:course-ch-2'],
      ['page:page', 'page:course-ch-2'],
    ),
    ['page:course-ch-1'],
  )
})

test("another document's pages are never swept", () => {
  assert.deepEqual(
    sweep(
      ['page:course-map-a-qmd', 'page:paper--parts-ch-0', 'page:something-else'],
      ['page:course-map-a-qmd'],
    ),
    [],
  )
})

test('the last page standing is never swept', () => {
  // tldraw requires a document to keep one page.
  assert.deepEqual(sweep(['page:course-ch-0'], []), [])
})
