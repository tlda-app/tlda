import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { describeTreeSize, measureTree } from './build-qmd.mjs'

// The tree copy in buildQmdDocument sits inside the phase of a chapter build
// that reports nothing -- measured 2026-09-12 as ~48s between a revision being
// accepted and quarto starting, with no line written. It copies the WHOLE
// source tree, so it scales with the size of the project rather than the size
// of the edit, and a duration without a size cannot tell a slow copy from a big
// one.
//
// Counts here are HAND-COUNTED in the fixture, never taken from the function's
// own arithmetic, so these can fail for the defect they claim to detect.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tlda-tree-size-'))
  writeFileSync(join(root, 'a.txt'), 'x'.repeat(1000))
  mkdirSync(join(root, 'sub'))
  writeFileSync(join(root, 'sub/b.txt'), 'y'.repeat(2000))
  writeFileSync(join(root, 'sub/c.txt'), 'zzz')
  symlinkSync('a.txt', join(root, 'link'))
  mkdirSync(join(root, 'empty'))
  return root
}

// Deliberate reds run against this, 2026-09-12, both fired:
//   dropping the symlink guard      -> 3008 bytes (the 5 chars of "a.txt")
//   counting directories as files   -> 6 files
test('counts files and bytes recursively, a symlink as one file of no bytes', () => {
  const root = fixture()
  try {
    // 4 files: a.txt, sub/b.txt, sub/c.txt, link. Two directories are not files.
    // 3003 bytes: 1000 + 2000 + 3. The symlink contributes none of a.txt's.
    const { files, bytes } = measureTree(root)
    assert.deepEqual({ files, bytes }, { files: 4, bytes: 3003 })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('reports how long its own walk took, because it adds cost to what it measures', () => {
  const root = fixture()
  try {
    assert.match(describeTreeSize(root), /measured in \d+ms$/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('skips an unreadable directory instead of throwing, so a size report cannot fail a build', () => {
  const root = fixture()
  const locked = join(root, 'locked')
  mkdirSync(locked)
  writeFileSync(join(locked, 'hidden.txt'), 'q'.repeat(50))
  chmodSync(locked, 0o000)
  try {
    // The readable files still report; the unreadable directory is passed over.
    assert.equal(measureTree(root).files, 4)
  } finally {
    chmodSync(locked, 0o755)
    rmSync(root, { recursive: true, force: true })
  }
})
