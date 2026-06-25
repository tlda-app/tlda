import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDocumentPageShape } from '../src/shapes/document-pages.ts'

test('temporary markdown columns are not document pages for fleet anchoring', () => {
  assert.equal(isDocumentPageShape({ type: 'svg-page', meta: {} }), true)
  assert.equal(isDocumentPageShape({ type: 'html-page', meta: {} }), true)
  assert.equal(isDocumentPageShape({
    type: 'html-page',
    meta: { temporaryMarkdownColumn: true },
  }), false)
  assert.equal(isDocumentPageShape({ type: 'fleet-chat', meta: {} }), false)
})
