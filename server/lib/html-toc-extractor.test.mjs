import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractHtmlToc } from './html-toc-extractor.mjs'

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
