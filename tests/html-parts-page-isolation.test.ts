import assert from 'node:assert/strict'
import test from 'node:test'

import { createHtmlDocumentFromPageInfo } from '../src/loaders/htmlLoader'

const pageInfo = [{
  file: 'part.html',
  width: 800,
  height: 1200,
}]

test('an ordinary HTML document reuses the primary page', () => {
  const document = createHtmlDocumentFromPageInfo('paper', '/docs/paper/', pageInfo)

  assert.equal(document.pages[0].tldrawPageId, 'page:page')
})

test('attached HTML parts get a page separate from the primary document', () => {
  const document = createHtmlDocumentFromPageInfo(
    'paper--parts',
    '/docs/paper/',
    pageInfo,
    { reuseDefaultPage: false },
  )

  assert.equal(document.pages[0].tldrawPageId, 'page:paper--parts-ch-0')
})

test('slides inside an HTML book keep their slide coordinates', () => {
  const document = createHtmlDocumentFromPageInfo('book', '/docs/book/', [{
    file: 'lecture-slide-2.html',
    width: 1050,
    height: 700,
    group: 'lecture.qmd',
    slideIndex: 2,
    indexh: 1,
    indexv: 3,
  }])

  assert.equal(
    document.pages[0].src,
    '/docs/book/lecture-slide-2.html?_tldaH=1&_tldaV=3',
  )
})
