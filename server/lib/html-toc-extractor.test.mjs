import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractHtmlToc } from './html-toc-extractor.mjs'

const CHAPTER_HTML = '<html><body><section id="what-a-sample-is"><h2>What a sample is</h2></section></body></html>'

test('grouped qmd slides produce a navigable chapter and slide TOC', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'tlda-qmd-toc-'))
  mkdirSync(join(outputDir, 'lectures'))
  writeFileSync(join(outputDir, 'lectures', 'one-slide-0.html'), '<h1 id="first">First</h1>')
  writeFileSync(join(outputDir, 'lectures', 'one-slide-1.html'), '<h1 id="second">Second</h1>')
  const pageInfo = [
    { file: 'lectures/one-slide-0.html', title: 'First', group: 'lectures/one.qmd', groupIndex: 0 },
    { file: 'lectures/one-slide-1.html', title: 'Second', group: 'lectures/one.qmd', groupIndex: 1 },
  ]
  writeFileSync(join(outputDir, 'page-info.json'), JSON.stringify(pageInfo))

  assert.deepEqual(extractHtmlToc(outputDir, pageInfo), [
    { title: 'First', level: 'chapter', page: 1 },
    { title: 'Second', level: 'section', page: 2 },
  ])
})

/**
 * A declared page that was not produced is a failed build.
 *
 * Skipping it drops the chapter silently: `page-info.json` declares the entry,
 * the HTML is absent, and the reader gets a book with a missing chapter and no
 * error anywhere. These two halves are the whole rule — a declared content page
 * must error, and a structural entry, which declares no file, must not.
 *
 * Fixtures are disposable, per AGENTS.md §"NEVER DISCUSS HIS PAPERS. VERIFY ON
 * A NEW PROJECT".
 */
test('a declared page whose HTML was not produced fails the build', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'tlda-toc-missing-page-'))
  try {
    writeFileSync(join(outputDir, 'intro.html'), CHAPTER_HTML)
    const pageInfo = [
      { file: 'intro.html', title: 'Introduction' },
      { file: 'sampling.html', title: 'Sampling' },
    ]
    writeFileSync(join(outputDir, 'page-info.json'), JSON.stringify(pageInfo))

    assert.throws(() => extractHtmlToc(outputDir, pageInfo), (err) => {
      // Diagnosable from the build log alone: the declaring file and the
      // missing path are both named.
      assert.match(err.message, /page-info\.json/)
      assert.match(err.message, /sampling\.html/)
      assert.match(err.message, new RegExp(join(outputDir, 'sampling.html').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      return true
    })
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})

test('a structural entry that declares no file is not a missing page', () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'tlda-toc-structural-'))
  try {
    writeFileSync(join(outputDir, 'sampling.html'), CHAPTER_HTML)
    const pageInfo = [
      { title: 'Part One', tocLevel: 'part' },
      { file: 'sampling.html', title: 'Sampling' },
    ]
    writeFileSync(join(outputDir, 'page-info.json'), JSON.stringify(pageInfo))

    assert.deepEqual(extractHtmlToc(outputDir, pageInfo), [
      { title: 'Chapter 1: Sampling', level: 'chapter', page: 2 },
      { title: 'What a sample is', level: 'subsection', page: 2, anchor: 'what-a-sample-is' },
    ])
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})
