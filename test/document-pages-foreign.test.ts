import assert from 'node:assert/strict'
import test from 'node:test'

import { isDocumentPageShape } from '../src/shapes/document-pages.ts'

test('legacy auto-opened foreign pages are not document pages', () => {
  assert.equal(isDocumentPageShape({
    id: 'shape:foreign-devbot-p3',
    type: 'svg-page',
    meta: {},
  }), false)
  assert.equal(isDocumentPageShape({
    id: 'shape:foreign-devbot-render-9a9bef53-markdown-p1',
    type: 'html-page',
    meta: {},
  }), false)
})

test('projects named foreign keep their own document pages', () => {
  assert.equal(isDocumentPageShape({
    id: 'shape:foreign-x-page-3',
    type: 'svg-page',
    meta: {},
  }), true)
})

test('newly tagged foreign pages are not document pages', () => {
  assert.equal(isDocumentPageShape({
    id: 'shape:any-page-1',
    type: 'svg-page',
    meta: { foreignDocumentPage: true },
  }), false)
})
