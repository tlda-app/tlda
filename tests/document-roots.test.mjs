import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeDocumentRoots } from '../shared/document-roots.mjs'

test('document roots carry their own format and preserve mixed projects', () => {
  assert.deepEqual(
    normalizeDocumentRoots([
      { path: './paper.tex', format: 'svg' },
      { path: 'notes.md', format: 'markdown' },
      { path: 'lecture.qmd', format: 'qmd' },
    ]),
    [
      { path: 'paper.tex', format: 'svg' },
      { path: 'notes.md', format: 'markdown' },
      { path: 'lecture.qmd', format: 'qmd' },
    ],
  )
})

test('legacy project metadata still exposes its primary document root', () => {
  assert.deepEqual(
    normalizeDocumentRoots(null, { mainFile: 'README.md', format: 'markdown' }),
    [{ path: 'README.md', format: 'markdown' }],
  )
})
