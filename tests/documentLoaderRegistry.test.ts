import assert from 'node:assert/strict'
import test from 'node:test'
import { loadDocumentFromManifest, type DocumentViewManifest } from '../src/loaders/documentLoaderRegistry'

const page = { file: 'page-1.svg', width: 612, height: 792 }

async function load(manifest: DocumentViewManifest) {
  return loadDocumentFromManifest({ name: 'document', basePath: '/docs/document/', manifest })
}

test('native PDF keeps source mapping disabled through the browser loader boundary', async () => {
  const document = await load({
    source: { format: 'pdf', renderer: 'identity', root: 'book.pdf' },
    document: { format: 'paged' },
    pages: [page],
    view: {
      kind: 'svg-pages',
      capabilities: { presentation: false, sourceMapping: false, searchableText: true },
    },
  })
  assert.equal(document.source.format, 'pdf')
  assert.equal(document.view.capabilities.sourceMapping, false)
})

test('Beamer keeps presentation behavior through the browser loader boundary', async () => {
  const document = await load({
    source: { format: 'tex', renderer: 'latex', root: 'main.tex' },
    document: { format: 'slides' },
    pages: [page],
    view: {
      kind: 'svg-pages',
      capabilities: { presentation: true, sourceMapping: true, searchableText: false },
    },
  })
  assert.equal(document.view.kind, 'svg-pages')
  assert.equal(document.view.capabilities.presentation, true)
})
