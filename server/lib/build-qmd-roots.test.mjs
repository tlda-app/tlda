import assert from 'node:assert/strict'
import test from 'node:test'

import { qmdDocumentRootPaths } from './build-qmd.mjs'

test('qmd document roots are rendered in declared order', () => {
  assert.deepEqual(qmdDocumentRootPaths({
    mainFile: 'index.qmd',
    documentRoots: [
      { path: 'index.qmd', format: 'qmd' },
      { path: 'chapters/one.qmd', format: 'qmd' },
      { path: 'chapters/two.qmd', format: 'qmd' },
    ],
  }), ['index.qmd', 'chapters/one.qmd', 'chapters/two.qmd'])
})

test('qmd roots ignore non-qmd entries and deduplicate paths', () => {
  assert.deepEqual(qmdDocumentRootPaths({
    mainFile: 'fallback.qmd',
    documentRoots: [
      { path: './chapter.qmd', format: 'qmd' },
      { path: 'chapter.qmd', format: 'qmd' },
      { path: 'notes.md', format: 'markdown' },
    ],
  }), ['chapter.qmd'])
})

test('qmd projects without declared roots render mainFile', () => {
  assert.deepEqual(qmdDocumentRootPaths({ mainFile: './talk.qmd' }), ['talk.qmd'])
})
