import assert from 'node:assert/strict'
import test from 'node:test'
import { documentTransport, foreignDocumentTransport } from './document-transport.mjs'

test('project move transport preserves native PDF axes and manifest page filenames', () => {
  assert.deepEqual(documentTransport({
    sourceFormat: 'pdf', renderer: 'identity', documentFormat: 'paged',
    pages: 2, pageFiles: ['book-page-1.svg', 'book-page-2.svg'],
  }), {
    sourceFormat: 'pdf', renderer: 'identity', documentFormat: 'paged',
    pages: 2, pageFiles: ['book-page-1.svg', 'book-page-2.svg'],
  })
})

test('foreign native PDF remains PDF and uses transported manifest filenames', () => {
  assert.deepEqual(foreignDocumentTransport({}, {
    sourceFormat: 'pdf', renderer: 'identity', documentFormat: 'paged',
    pages: 2, pageFiles: ['scan-01.svg', 'scan-02.svg'],
  }), {
    sourceFormat: 'pdf', renderer: 'identity', documentFormat: 'paged', format: 'pdf',
    pages: 2, pageFiles: ['scan-01.svg', 'scan-02.svg'],
  })
})
