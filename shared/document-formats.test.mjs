import assert from 'node:assert/strict'
import test from 'node:test'

import { documentAxes, viewFormat } from './document-formats.mjs'

test('runtime axes reject an unmigrated project record', () => {
  assert.throws(() => documentAxes({ format: 'svg' }), /have not been migrated/)
})

test('explicit axes route QMD output independently of its source format', () => {
  const project = { sourceFormat: 'qmd', renderer: 'quarto', documentFormat: 'paged' }
  assert.deepEqual(documentAxes(project), {
    sourceFormat: 'qmd', renderer: 'quarto', documentFormat: 'paged',
  })
  assert.equal(viewFormat(project), 'svg')
  assert.equal(viewFormat({ sourceFormat: 'pdf', renderer: 'identity', documentFormat: 'paged' }), 'pdf')
})
