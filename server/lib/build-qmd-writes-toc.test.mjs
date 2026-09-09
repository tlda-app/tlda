import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { writeTocJson } from './build-qmd.mjs'

// An output directory shaped the way the native tlda-project branch leaves it:
// rendered HTML plus the page-info it just wrote. No Quarto run required.
function renderedOutput() {
  const outDir = mkdtempSync(join(tmpdir(), 'tlda-native-toc-'))
  const pages = [
    { file: 'index.html', title: 'Prediction, Inference, and Causality' },
    { file: 'lectures/chapter-sampling.html', title: 'Sampling' },
  ]
  mkdirSync(join(outDir, 'lectures'), { recursive: true })
  writeFileSync(join(outDir, 'index.html'), '<html><body><h1>Prediction, Inference, and Causality</h1></body></html>')
  writeFileSync(
    join(outDir, 'lectures', 'chapter-sampling.html'),
    '<html><body><h1>Sampling</h1><h2>Simple random samples</h2></body></html>',
  )
  writeFileSync(join(outDir, 'page-info.json'), JSON.stringify(pages, null, 2))
  return { outDir, pages }
}

test('the native branch writes a toc.json carrying the rendered headings', () => {
  const { outDir, pages } = renderedOutput()
  try {
    // Absent before: this is the state the ToC panel found and reported as
    // "No headings found".
    assert.equal(existsSync(join(outDir, 'toc.json')), false)

    const returned = writeTocJson(outDir, pages)

    assert.equal(existsSync(join(outDir, 'toc.json')), true, 'toc.json must exist after the build writes it')
    const onDisk = JSON.parse(readFileSync(join(outDir, 'toc.json'), 'utf8'))
    assert.deepEqual(onDisk, returned, 'what is written and what is returned must agree')
    assert.ok(onDisk.length > 0, 'a rendered book with headings must not produce an empty toc')

    const titles = onDisk.map((entry) => entry.title)
    assert.ok(
      titles.some((title) => /Sampling/.test(title)),
      `expected a heading from the rendered pages, got ${JSON.stringify(titles)}`,
    )
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('the toc comes from the pages passed in, not from page-info on disk', () => {
  const { outDir, pages } = renderedOutput()
  try {
    // A stale page-info naming a page that was not rendered must not decide the
    // toc; the branch passes the pages it actually produced.
    writeFileSync(
      join(outDir, 'page-info.json'),
      JSON.stringify([{ file: 'gone.html', title: 'Removed' }], null, 2),
    )
    const toc = writeTocJson(outDir, pages)
    assert.ok(
      toc.map((entry) => entry.title).some((title) => /Sampling/.test(title)),
      'toc must reflect the rendered pages, not the stale file',
    )
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})
