import assert from 'node:assert/strict'
import test from 'node:test'

import { isQuartoRenderOutput } from '../shared/source-manifest.mjs'

test('named Quarto book output directories are render output', () => {
  assert.equal(isQuartoRenderOutput('_book-ctd/lectures/chapter.html', 'index.qmd'), true)
  assert.equal(isQuartoRenderOutput('lectures/chapter.qmd', 'index.qmd'), false)
})
