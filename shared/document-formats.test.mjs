import assert from 'node:assert/strict'
import test from 'node:test'

import { documentAxes, hasSourceMapping } from './document-formats.mjs'

// This file used to assert `documentAxes({ format: 'svg' })` THROWS
// /have not been migrated/. That assertion is gone deliberately, and the reason
// is a measurement rather than a preference.
//
// The throw was paired with an `assertStoredProjectAxes` walk over every project
// at startup. Measured against the RC branch's own project-store: a store
// holding one project that still carried `format` stopped `initProjectStore`
// outright, so the server did not start at all — and a project carrying BOTH the
// axes and `format` was rejected too, so the conversion could not be staged over
// two passes. Re-running converged on nothing because no migration existed; the
// branch's own `docs/document-formats.md` said so on purpose.
//
// Every project on every real box carries `format`. So the tests below assert
// the property that makes the RC usable at all: a pre-RC record is READ, not
// refused.

test('a pre-RC project record yields its axes instead of being refused', () => {
  assert.deepEqual(documentAxes({ format: 'svg' }), {
    sourceFormat: 'tex', renderer: 'latex', documentFormat: 'paged',
  })
})

test('every value a stored format can hold has axes — no project is unreadable', () => {
  for (const format of ['svg', 'markdown', 'html', 'slides', 'qmd', 'png', 'book']) {
    const axes = documentAxes({ format })
    assert.ok(axes.sourceFormat && axes.renderer && axes.documentFormat,
      `${format} must map to all three axes`)
  }
})

test('a qmd that rendered a deck is slides, which format alone cannot say', () => {
  // The one case where the axes are not a function of `format`. Getting this
  // wrong sends a deck down the scrolling-document path, which is the defect
  // `renderedFormat` was added to `main` to prevent in the first place.
  assert.equal(documentAxes({ format: 'qmd', renderedFormat: 'slides' }).documentFormat, 'slides')
  assert.equal(documentAxes({ format: 'qmd' }).documentFormat, 'html')
})

test('explicit axes route QMD output independently of its source format', () => {
  const project = { sourceFormat: 'qmd', renderer: 'quarto', documentFormat: 'paged' }
  assert.deepEqual(documentAxes(project), {
    sourceFormat: 'qmd', renderer: 'quarto', documentFormat: 'paged',
  })
})

test('stored axes win over a stale format field', () => {
  // A record part-way through conversion carries both. The RC's version rejected
  // exactly this shape; it has to be readable, or nothing can convert
  // incrementally.
  const axes = documentAxes({ format: 'svg', sourceFormat: 'pdf', renderer: 'identity', documentFormat: 'paged' })
  assert.equal(axes.sourceFormat, 'pdf')
  assert.equal(axes.renderer, 'identity')
})

test('only a LaTeX build claims source mapping', () => {
  // synctex comes from latexmk and nothing else, so a PDF opened directly has
  // pages and text but no route back to a source line.
  assert.equal(hasSourceMapping({ format: 'svg' }), true)
  assert.equal(hasSourceMapping({ sourceFormat: 'pdf', renderer: 'identity', documentFormat: 'paged' }), false)
  assert.equal(hasSourceMapping({ format: 'qmd' }), false)
})
