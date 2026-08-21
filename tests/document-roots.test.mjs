import assert from 'node:assert/strict'
import test from 'node:test'

import { latexDocumentRootPaths, normalizeDocumentRoots } from '../shared/document-roots.mjs'

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

test('declared TeX documents are build targets without an externaldocument edge', () => {
  assert.deepEqual(latexDocumentRootPaths([
    { path: 'revision/manuscript.tex', format: 'svg' },
    { path: 'revision/supplementary_appendix.tex', format: 'svg' },
  ], {
    mainFile: 'revision/manuscript.tex',
    format: 'svg',
    xrSiblings: ['revision/manuscript.tex'],
  }), [
    'revision/manuscript.tex',
    'revision/supplementary_appendix.tex',
  ])
})
