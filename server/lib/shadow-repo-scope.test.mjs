import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { isGeneratedSvgCompanionPdf } from './shadow-repo.mjs'

test('SVG companion PDFs are generated build inputs, not source scope', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-shadow-scope-'))
  try {
    fs.mkdirSync(path.join(root, 'figures'))
    fs.writeFileSync(path.join(root, 'figures', 'plot.svg'), '<svg/>')

    assert.equal(isGeneratedSvgCompanionPdf('figures/plot.pdf', root), true)
    assert.equal(isGeneratedSvgCompanionPdf('figures/source-only.pdf', root), false)
    assert.equal(isGeneratedSvgCompanionPdf('figures/plot.svg', root), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
