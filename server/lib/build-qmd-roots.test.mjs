import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { qmdDocumentRootPaths, qmdRenderedOutputFileForSource } from './build-qmd.mjs'

test('qmd document roots are rendered in declared order', () => {
  assert.deepEqual(qmdDocumentRootPaths({
    mainFile: 'index.qmd',
    documentRoots: [
      { path: 'index.qmd', format: 'qmd' },
      { path: 'chapters/one.qmd', format: 'qmd' },
      { path: 'chapters/two.qmd', format: 'qmd' },
    ],
  }), ['index.qmd', 'chapters/one.qmd', 'chapters/two.qmd'])
})

test('qmd roots ignore non-qmd entries and deduplicate paths', () => {
  assert.deepEqual(qmdDocumentRootPaths({
    mainFile: 'fallback.qmd',
    documentRoots: [
      { path: './chapter.qmd', format: 'qmd' },
      { path: 'chapter.qmd', format: 'qmd' },
      { path: 'notes.md', format: 'markdown' },
    ],
  }), ['chapter.qmd'])
})

test('qmd projects without declared roots render mainFile', () => {
  assert.deepEqual(qmdDocumentRootPaths({ mainFile: './talk.qmd' }), ['talk.qmd'])
})

test('qmd book roots resolve from the Quarto _book directory', (t) => {
  const outDir = mkdtempSync(join(tmpdir(), 'tlda-qmd-book-output-'))
  t.after(() => rmSync(outDir, { recursive: true, force: true }))
  mkdirSync(join(outDir, '_book', 'chapters'), { recursive: true })
  writeFileSync(join(outDir, '_book', 'chapters', 'one.html'), '<html></html>')
  assert.equal(qmdRenderedOutputFileForSource(outDir, 'chapters/one.qmd'), '_book/chapters/one.html')
  assert.equal(qmdRenderedOutputFileForSource(outDir, 'chapters/missing.qmd'), null)

  mkdirSync(join(outDir, 'chapters'), { recursive: true })
  writeFileSync(join(outDir, 'chapters', 'one.html'), '<html></html>')
  assert.equal(qmdRenderedOutputFileForSource(outDir, 'chapters/one.qmd'), 'chapters/one.html')
})
