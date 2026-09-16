import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { deckPageInfo } from './slides-parser.mjs'
import { qmdDeckPageInfo, qmdDeclaredOutputFilesForSource, qmdMissingDeclaredOutputFiles, qmdRenderedOutputFilesForSource } from './build-qmd.mjs'

test('a qmd source honors a top-level output-file', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-output-file-'))
  try {
    mkdirSync(join(root, 'homework'), { recursive: true })
    writeFileSync(join(root, 'homework', 'homework-calibration.handout.qmd'), `---
title: Homework
output-file: homework-calibration.html
---
`)
    writeFileSync(join(root, 'homework', 'homework-calibration.html'), '<html></html>')

    assert.deepEqual(qmdDeclaredOutputFilesForSource(root, 'homework/homework-calibration.handout.qmd'), [
      'homework/homework-calibration.html',
    ])
    assert.deepEqual(qmdRenderedOutputFilesForSource(root, 'homework/homework-calibration.handout.qmd'), [
      'homework/homework-calibration.html',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

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
    rmSync(join(root, 'lectures', 'Lab1-prose-slides.html'))
    assert.deepEqual(qmdDeclaredOutputFilesForSource(root, 'lectures/Lab1-prose.qmd'), [
      'lectures/Lab1-prose.html',
      'lectures/Lab1-prose-slides.html',
    ])
    assert.deepEqual(qmdRenderedOutputFilesForSource(root, 'lectures/Lab1-prose.qmd'), [
      'lectures/Lab1-prose.html',
    ])
    assert.deepEqual(qmdMissingDeclaredOutputFiles(root, 'lectures/Lab1-prose.qmd'), [
      'lectures/Lab1-prose-slides.html',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the deck entry carries the slides variant without changing its source authority', () => {
  const entry = qmdDeckPageInfo('lectures/Lab1-prose.qmd', {
    file: 'Lab1-prose-slides.html',
    width: 1600,
    height: 900,
    slides: [{ index: 0, indexh: 0, indexv: 0 }, { index: 1, indexh: 1, indexv: 0 }],
  }, 'slides')

  assert.equal(entry.variant, 'slides')
  assert.deepEqual(entry.source, {
    type: 'project-source',
    format: 'qmd',
    file: 'lectures/Lab1-prose.qmd',
  })
  // The book builder adds map membership. A deck entry by itself is not a
  // side-by-side comparison group.
  assert.equal(entry.map, undefined)
  assert.equal(entry.group, undefined)
  assert.equal(entry.slides.length, 2)
})

test('a deck is one document, not one per slide', () => {
  const deck = deckPageInfo(`<div class="slides">
    <section class="slide level2"><h2>One</h2></section>
    <section><section class="slide level2"><h2>Two</h2></section>
    <section class="slide level2"><h2>Three</h2></section></section>
  </div>`, 'deck.html')

  assert.equal(deck.file, 'deck.html')
  assert.equal(deck.slides.length, 3)
  // Verticals live under their own column: the address is 2D and the layout
  // reads it rather than reading document order.
  assert.deepEqual(deck.slides.map(s => [s.indexh, s.indexv]), [[0, 0], [1, 0], [1, 1]])
})
