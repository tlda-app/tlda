import assert from 'node:assert/strict'
import test from 'node:test'

import { documentAxes, legacyDocumentAxes, viewFormat } from './document-formats.mjs'

test('the migration boundary derives all three axes from legacy records', () => {
  assert.deepEqual(legacyDocumentAxes({ format: 'svg' }), {
    sourceFormat: 'tex', renderer: 'latex', documentFormat: 'paged',
  })
  assert.deepEqual(legacyDocumentAxes({ format: 'markdown' }), {
    sourceFormat: 'md', renderer: 'markdown', documentFormat: 'html',
  })
  assert.deepEqual(legacyDocumentAxes({ format: 'qmd', renderedFormat: 'slides' }), {
    sourceFormat: 'qmd', renderer: 'quarto', documentFormat: 'slides',
  })
})

test('runtime axes reject an unmigrated project record', () => {
  assert.throws(() => documentAxes({ format: 'svg' }), /have not been migrated/)
})

test('explicit axes route QMD output independently of its source format', () => {
  const project = { format: 'qmd', sourceFormat: 'qmd', renderer: 'quarto', documentFormat: 'paged' }
  assert.deepEqual(documentAxes(project), {
    sourceFormat: 'qmd', renderer: 'quarto', documentFormat: 'paged',
  })
  assert.equal(viewFormat(project), 'svg')
  assert.equal(viewFormat({ sourceFormat: 'pdf', renderer: 'identity', documentFormat: 'paged' }), 'pdf')
})
