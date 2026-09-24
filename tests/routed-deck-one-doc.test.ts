import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import type { SvgDocument } from '../src/loaders/types'

// tldraw opens an internal MessagePort when its runtime is imported. Capture
// only the handles introduced by this test's dynamic import, then close them so
// the Node test worker can finish naturally instead of timing out.
const handlesBeforeTldraw = new Set(process._getActiveHandles())
const { presentationDocumentForRoutedDeck } = await import('../src/loaders/slidesLoader')
const tldrawHandles = process._getActiveHandles().filter(handle => !handlesBeforeTldraw.has(handle))
after(() => {
  for (const handle of tldrawHandles) {
    if (handle.constructor?.name === 'MessagePort' && 'close' in handle) {
      ;(handle as { close: () => void }).close()
    }
  }
})

/**
 * A book deck opened as its own presentation navigates the same one-doc path
 * a solo deck does: one page, the whole-deck iframe, and the slide layout the
 * navigator pans across. The per-slide expansion this replaces is deleted from
 * htmlLoader rather than kept beside it.
 */

const bookDocument = (): SvgDocument => ({
  name: 'course',
  basePath: '/docs/course/',
  format: 'html',
  pages: [
    {
      src: '/docs/course/one.html',
      bounds: { x: 0, y: 0, w: 800, h: 1200 } as never,
      assetId: 'asset:one' as never,
      shapeId: 'shape:one' as never,
      width: 800,
      height: 1200,
    },
    {
      src: '/docs/course/one-slides.html?_tldaDeck=1&view=scroll',
      bounds: { x: 90800, y: 0, w: 1200, h: 700 } as never,
      assetId: 'asset:deck' as never,
      shapeId: 'shape:deck' as never,
      width: 1200,
      height: 700,
      meta: { spatialWorldDocument: true, materializedFile: 'one-slides.html' },
    },
  ],
  slideInfo: [{
    file: 'one-slides.html',
    width: 1200,
    height: 700,
    variant: 'slides',
    slides: [
      { index: 0, indexh: 0, indexv: 0 },
      { index: 1, indexh: 1, indexv: 0 },
      { index: 2, indexh: 1, indexv: 1 },
    ],
  }],
})

test('a routed book deck presents one page with the solo slide layout', () => {
  const presented = presentationDocumentForRoutedDeck(bookDocument(), 'one-slides.html')

  assert.equal(presented.format, 'slides')
  assert.equal(presented.pages.length, 1)
  assert.match(presented.pages[0].src, /_tldaDeck=1/)
  // The navigator's address space: one rect per slide, the deck's own
  // structure made spatial, exactly as a solo deck lays it out.
  assert.equal(presented.deckLayout?.rects.length, 3)
  assert.deepEqual(
    presented.deckLayout?.rects.map(rect => [rect.indexh, rect.indexv]),
    [[0, 0], [1, 0], [1, 1]],
  )
  assert.equal(presented.slideInfo?.length, 1)
})

test('a routed file with no slideInfo still presents its page', () => {
  const presented = presentationDocumentForRoutedDeck(bookDocument(), 'one.html')

  assert.equal(presented.format, 'slides')
  assert.equal(presented.pages.length, 0)
  assert.equal(presented.deckLayout, undefined)
})

test('a deck whose slides array is missing navigates the one box', () => {
  const document = bookDocument()
  document.slideInfo = [{
    file: 'one-slides.html',
    width: 1200,
    height: 700,
    variant: 'slides',
    slides: [],
  }]

  const presented = presentationDocumentForRoutedDeck(document, 'one-slides.html')

  assert.equal(presented.pages.length, 1)
  assert.equal(presented.deckLayout, undefined)
})
