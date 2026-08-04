import assert from 'node:assert/strict'
import test from 'node:test'

import { pageInfoFromTldaManifest } from './tlda-manifest.mjs'

test('maps the version 1 tlda manifest to ordered page info', () => {
  const pages = pageInfoFromTldaManifest({
    version: 1,
    kind: 'tlda',
    pages: [
      {
        file: 'chapter.html',
        title: 'Chapter',
        source: { type: 'project-source', format: 'qmd', file: 'chapter.qmd' },
      },
      {
        file: 'index.html',
        title: 'Introduction',
        source: { type: 'project-source', format: 'qmd', file: 'index.qmd' },
      },
    ],
  }, { prefix: '_book' })

  assert.deepEqual(pages.map(page => page.file), ['_book/chapter.html', '_book/index.html'])
  assert.deepEqual(pages[0], {
    file: '_book/chapter.html',
    width: 800,
    height: 1200,
    title: 'Chapter',
    format: 'qmd',
    source: { type: 'project-source', format: 'qmd', file: 'chapter.qmd' },
  })
})

test('rejects paths that escape the rendered project', () => {
  assert.throws(() => pageInfoFromTldaManifest({
    version: 1,
    kind: 'tlda',
    pages: [{
      file: '../outside.html',
      title: 'Outside',
      source: { type: 'project-source', format: 'qmd', file: 'outside.qmd' },
    }],
  }), /must stay inside the project/)
})
