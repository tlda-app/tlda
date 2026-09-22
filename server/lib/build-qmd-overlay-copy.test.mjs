import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { copySourceTreeOverSeed } from './incremental-qmd-build.mjs'

// The live defect: the seeded render tree holds a regular `_quarto.yml` from
// the last build, and the source tree declares `_quarto.yml` as a symlink onto
// `_quarto_book.yml`. `cpSync(src, out, { recursive: true })` throws EEXIST on
// that overlay (`force: true` does not change it on Node 26), and a source
// tree carrying `.git` drags read-only objects into the render tree that kill
// a later copy with EACCES.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tlda-qmd-overlay-'))
  const src = join(root, 'src')
  const out = join(root, 'out')
  mkdirSync(join(src, 'chapters'), { recursive: true })
  mkdirSync(join(src, '.git', 'objects'), { recursive: true })
  mkdirSync(join(out, '_book', 'chapters'), { recursive: true })
  mkdirSync(join(out, 'chapters'), { recursive: true })
  writeFileSync(join(src, '_quarto_book.yml'), 'project:\n  type: tlda\n')
  symlinkSync('_quarto_book.yml', join(src, '_quarto.yml'))
  writeFileSync(join(src, '.git', 'objects', 'pack'), 'pack-bytes\n')
  writeFileSync(join(src, 'chapters', 'ch.qmd'), '# New\n')
  writeFileSync(join(out, '_quarto.yml'), 'stale regular file\n')
  writeFileSync(join(out, '_book', 'chapters', 'kept.html'), '<!-- seeded-only render -->\n')
  writeFileSync(join(out, 'chapters', 'ch.qmd'), '# Old\n')
  return { root, src, out }
}

test('source overlays the seeded tree: symlink wins, .git stays out, seeded-only outputs survive', () => {
  const { root, src, out } = fixture()
  try {
    copySourceTreeOverSeed(src, out)
    assert.equal(lstatSync(join(out, '_quarto.yml')).isSymbolicLink(), true)
    assert.equal(readlinkSync(join(out, '_quarto.yml')), '_quarto_book.yml')
    assert.equal(readFileSync(join(out, 'chapters', 'ch.qmd'), 'utf8'), '# New\n')
    assert.equal(readFileSync(join(out, '_book', 'chapters', 'kept.html'), 'utf8'), '<!-- seeded-only render -->\n')
    assert.equal(existsSync(join(out, '.git')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the overlay is idempotent: a second pass over its own result does not throw', () => {
  const { root, src, out } = fixture()
  try {
    copySourceTreeOverSeed(src, out)
    copySourceTreeOverSeed(src, out)
    assert.equal(readlinkSync(join(out, '_quarto.yml')), '_quarto_book.yml')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
