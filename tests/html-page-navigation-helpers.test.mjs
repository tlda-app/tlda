import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ANCHOR_RESOLVE_TIMEOUT_MS,
  createLinkPeekTracker,
  docviewInLayoutExtent,
  findNavigateTargetShape,
  htmlPageUrlMatchesTargetFile,
} from '../src/html-page-navigation-helpers.ts'

// A navigation that resolves to nothing is silent: no error, no motion, and a
// click that simply does nothing. These are the encodings the book has to
// answer to, measured on the served book rather than reasoned about.

const CHAPTER_URL =
  'https://tlda-fly.cormorant-matrix.ts.net/docs/qtm285-book/app/book/chapters/chapter-sampling.html'

test('a .qmd link resolves to the chapter .html the shape serves', () => {
  // The served course index links `chapter-bootstrap-slides.qmd`; the shape
  // serves the rendered `.html`. Authors write `.qmd`, Quarto keeps some of
  // those hrefs, and the click used to match nothing.
  assert.equal(
    htmlPageUrlMatchesTargetFile(
      'https://tlda-fly.cormorant-matrix.ts.net/docs/qtm285-book/app/book/decks/chapter-bootstrap-slides.html',
      'chapter-bootstrap-slides.qmd',
    ),
    true,
  )
})

test('a .qmd link keeps working with a path prefix', () => {
  assert.equal(htmlPageUrlMatchesTargetFile(CHAPTER_URL, 'chapters/chapter-sampling.qmd'), true)
})

test('an unrelated file still matches nothing', () => {
  assert.equal(htmlPageUrlMatchesTargetFile(CHAPTER_URL, 'chapter-models.html'), false)
  assert.equal(htmlPageUrlMatchesTargetFile(CHAPTER_URL, 'chapter-models.qmd'), false)
  assert.equal(htmlPageUrlMatchesTargetFile(CHAPTER_URL, ''), false)
})

const shapes = [
  { id: 'shape:book-page-1', props: { url: `${CHAPTER_URL}` } },
  {
    id: 'shape:book-page-2',
    props: {
      url: 'https://tlda-fly.cormorant-matrix.ts.net/docs/qtm285-book/app/book/chapters/chapter-models.html',
    },
  },
]

test('resolution by file finds the shape serving it', () => {
  assert.equal(
    findNavigateTargetShape(shapes, 'chapter-models.html', 'shape:book-page-1')?.id,
    'shape:book-page-2',
  )
})

test('resolution by file never falls back to the clicking shape', () => {
  // An unknown file with a valid clicking-shape id resolves to nothing — the
  // caller reports it loudly — rather than quietly landing somewhere unasked.
  assert.equal(
    findNavigateTargetShape(shapes, 'missing-chapter.html', 'shape:book-page-1'),
    null,
  )
})

test('a same-page anchor resolves to the clicking shape', () => {
  assert.equal(
    findNavigateTargetShape(shapes, null, 'shape:book-page-1')?.id,
    'shape:book-page-1',
  )
})

test('an anchor with no shape and no file resolves to nothing', () => {
  assert.equal(findNavigateTargetShape(shapes, null, null), null)
  assert.equal(findNavigateTargetShape(shapes, '', ''), null)
})

test('a margin docview is in the visible layout', () => {
  // Measured on the index canvas: the slot docview sits 440 units left of the
  // index. Membership is document-relative, so the camera plays no part.
  const doc = { x: 0, y: 0, w: 800, h: 10876 }
  assert.equal(docviewInLayoutExtent(doc, { x: -440, y: 0, w: 400, h: 300 }), true)
})

test('a docview 24,000 units out is not in the visible layout', () => {
  // Measured on the chapter canvas: clicks wrote here and returned without
  // moving the camera, so nothing visible happened.
  const doc = { x: 0, y: 0, w: 800, h: 7771 }
  assert.equal(docviewInLayoutExtent(doc, { x: -24533, y: -584, w: 504, h: 147 }), false)
})

test('a docview a deck above the document is in the visible layout', () => {
  const doc = { x: 0, y: 2000, w: 1600, h: 900 }
  assert.equal(docviewInLayoutExtent(doc, { x: 100, y: 1500, w: 400, h: 300 }), true)
})

test('a docview pages below the document is not in the visible layout', () => {
  const doc = { x: 0, y: 0, w: 800, h: 7771 }
  assert.equal(docviewInLayoutExtent(doc, { x: 0, y: 30000, w: 400, h: 300 }), false)
})

test('a repeated untouched peek commits', () => {
  const tracker = createLinkPeekTracker()
  tracker.recordPeek('page:one', 'shape:book-page-1::fig-a')
  assert.equal(tracker.shouldCommit('page:one', 'shape:book-page-1::fig-a'), true)
})

test('touching the docview between clicks keeps peeking', () => {
  const tracker = createLinkPeekTracker()
  tracker.recordPeek('page:one', 'shape:book-page-1::fig-a')
  tracker.noteTouch()
  assert.equal(tracker.shouldCommit('page:one', 'shape:book-page-1::fig-a'), false)
})

test('a different link, anchor, or page does not commit', () => {
  const tracker = createLinkPeekTracker()
  tracker.recordPeek('page:one', 'shape:book-page-1::fig-a')
  assert.equal(tracker.shouldCommit('page:one', 'shape:book-page-1::fig-b'), false)
  assert.equal(tracker.shouldCommit('page:one', 'shape:book-page-2::fig-a'), false)
  assert.equal(tracker.shouldCommit('page:two', 'shape:book-page-1::fig-a'), false)
})

test('the anchor wait covers a slow cold chapter load', () => {
  // Measured on testing: chapter-comparing-two-groups took 27.8s from click
  // to first positions. Anything under that strands a cold cross-chapter
  // click at the top of the chapter.
  assert.ok(ANCHOR_RESOLVE_TIMEOUT_MS >= 60000)
})

test('committing clears the peek, so the next click peeks again', () => {
  const tracker = createLinkPeekTracker()
  tracker.recordPeek('page:one', 'shape:book-page-1::fig-a')
  assert.equal(tracker.shouldCommit('page:one', 'shape:book-page-1::fig-a'), true)
  tracker.clear()
  assert.equal(tracker.shouldCommit('page:one', 'shape:book-page-1::fig-a'), false)
})
