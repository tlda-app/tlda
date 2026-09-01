import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { qmdDeckPageInfo, qmdRenderedOutputFilesForSource } from './build-qmd.mjs'

test('a qmd source resolves both declared non-colliding output files', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-alternates-'))
  try {
    mkdirSync(join(root, 'lectures'), { recursive: true })
    writeFileSync(join(root, 'lectures', 'Lab1-prose.qmd'), `---
title: Sampling
format:
  r-wasm/live-html:
    output-file: Lab1-prose.html
  r-wasm/live-revealjs:
    output-file: Lab1-prose-slides.html
---
`)
    writeFileSync(join(root, 'lectures', 'Lab1-prose.html'), '<html></html>')
    writeFileSync(join(root, 'lectures', 'Lab1-prose-slides.html'), '<html></html>')

    assert.deepEqual(qmdRenderedOutputFilesForSource(root, 'lectures/Lab1-prose.qmd'), [
      'lectures/Lab1-prose.html',
      'lectures/Lab1-prose-slides.html',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('split deck entries carry the slides variant without changing their source authority', () => {
  const entries = qmdDeckPageInfo('lectures/Lab1-prose.qmd', [{
    pageInfo: { file: 'Lab1-prose-slides-slide-0.html', width: 1600, height: 900 },
  }], 'slides')

  assert.equal(entries[0].variant, 'slides')
  assert.deepEqual(entries[0].source, {
    type: 'project-source',
    format: 'qmd',
    file: 'lectures/Lab1-prose.qmd',
  })
})
