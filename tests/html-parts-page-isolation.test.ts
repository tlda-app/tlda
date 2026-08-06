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
