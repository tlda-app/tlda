import assert from 'node:assert/strict'
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { collectProjectSourceHashes, splitServerSourcePathsByManifest } from '../cli/lib/source-files.mjs'
import { isQuartoRenderOutput, isSourceFilePath, normalizeSourceManifest } from '../shared/source-manifest.mjs'

test('named Quarto book output directories are render output', () => {
  assert.equal(isQuartoRenderOutput('_book-ctd/lectures/chapter.html', 'index.qmd'), true)
  assert.equal(isQuartoRenderOutput('lectures/chapter.qmd', 'index.qmd'), false)
})

test('Quarto freeze directories are render output', () => {
  assert.equal(isQuartoRenderOutput('_freeze/lectures/chapter/execute-results/html.json', 'index.qmd'), true)
  assert.equal(isQuartoRenderOutput('lectures/_freeze-notes/chapter.qmd', 'index.qmd'), false)
})

test('declared main file is source even when its extension is not generic source', () => {
  const qmdBook = { format: 'qmd', mainFile: '_quarto_book.yml' }
  assert.equal(isSourceFilePath('_quarto_book.yml', qmdBook), true)
  assert.deepEqual(normalizeSourceManifest(['_quarto_book.yml'], qmdBook), ['_quarto_book.yml'])
})

test('markdown main file rule does not admit unrelated markdown beside TeX', () => {
  const latex = { format: 'svg', mainFile: 'paper.md' }
  assert.equal(isSourceFilePath('paper.md', latex), true)
  assert.equal(isSourceFilePath('notes.md', latex), false)
  assert.equal(isSourceFilePath('notes.md', { ...latex, referencedRoots: ['notes.md'] }), true)
})

test('qmd batch manifests carry only server paths surviving the final manifest', () => {
  const split = splitServerSourcePathsByManifest(
    { '.mcp.json': 'old', '_quarto_book.yml': 'old', 'lectures/intro.qmd': 'old' },
    ['_quarto_book.yml', 'lectures/intro.qmd'],
  )
  assert.deepEqual(split.survivingServerPaths, ['_quarto_book.yml', 'lectures/intro.qmd'])
  assert.deepEqual(split.staleServerPaths, ['.mcp.json'])
})

test('qmd source scan keeps main yml and skips symlinks outside the source root', () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-source-scan-'))
  const outside = mkdtempSync(join(tmpdir(), 'tlda-qmd-source-outside-'))
  writeFileSync(join(root, '_quarto_book.yml'), 'project:\n  type: book\n')
  writeFileSync(join(root, 'chapter.qmd'), '# Chapter\n')
  writeFileSync(join(outside, '.mcp.json'), '{"outside":true}\n')
  symlinkSync(join(outside, '.mcp.json'), join(root, '.mcp.json'))

  const hashes = collectProjectSourceHashes(root, { format: 'qmd', mainFile: '_quarto_book.yml' })
  assert.equal('_quarto_book.yml' in hashes, true)
  assert.equal('chapter.qmd' in hashes, true)
  assert.equal('.mcp.json' in hashes, false)
})
