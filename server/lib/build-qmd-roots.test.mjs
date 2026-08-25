import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { qmdDeckPageInfo, qmdDocumentRootPaths, qmdRenderedOutputFileForSource, qmdRootsToRender } from './build-qmd.mjs'

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

test('slides from one qmd root share one document location', () => {
  const pages = qmdDeckPageInfo('lectures/one.qmd', [
    { pageInfo: { file: 'one-slide-0.html', title: 'First' } },
    { pageInfo: { file: 'one-slide-1.html', title: 'Second' } },
  ])
  assert.deepEqual(pages.map(page => [page.group, page.groupIndex, page.source.file]), [
    ['lectures/one.qmd', 0, 'lectures/one.qmd'],
    ['lectures/one.qmd', 1, 'lectures/one.qmd'],
  ])
})

test('qmd source changes render only roots whose dependency closures contain them', (t) => {
  const source = mkdtempSync(join(tmpdir(), 'tlda-qmd-root-selection-'))
  t.after(() => rmSync(source, { recursive: true, force: true }))
  mkdirSync(join(source, 'chapters'), { recursive: true })
  writeFileSync(join(source, 'index.qmd'), '# Index\n')
  writeFileSync(join(source, 'chapters', 'one.qmd'), '{{< include shared.qmd >}}\n')
  writeFileSync(join(source, 'chapters', 'shared.qmd'), 'shared\n')
  writeFileSync(join(source, 'chapters', 'two.qmd'), '# Two\n')
  const roots = ['index.qmd', 'chapters/one.qmd', 'chapters/two.qmd']

  assert.deepEqual(qmdRootsToRender(roots, source, ['chapters/two.qmd']), ['chapters/two.qmd'])
  assert.deepEqual(qmdRootsToRender(roots, source, ['chapters/shared.qmd']), ['chapters/one.qmd'])
})

test('qmd project-wide or untracked dependency changes render every root', (t) => {
  const source = mkdtempSync(join(tmpdir(), 'tlda-qmd-project-selection-'))
  t.after(() => rmSync(source, { recursive: true, force: true }))
  writeFileSync(join(source, 'one.qmd'), '# One\n')
  writeFileSync(join(source, 'two.qmd'), '# Two\n')
  const roots = ['one.qmd', 'two.qmd']

  assert.deepEqual(qmdRootsToRender(roots, source, ['_quarto.yml']), roots)
  assert.deepEqual(qmdRootsToRender(roots, source, ['data/input.csv']), roots)
  assert.deepEqual(qmdRootsToRender(roots, source, null), roots)
})
