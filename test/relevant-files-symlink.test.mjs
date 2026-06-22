// Regression test for the synth-supplement shadow-commit freeze (2026-06-22).
//
// Fly's fly-entrypoint-live.sh symlinks /app/server/projects ->
// /app/server/persist/projects (commit 46fb299d, 2026-06-14). writeRelevantFiles
// realpath-resolves each .fls INPUT path (→ the persist path) and used to test it
// against the UN-resolved srcDir, so the prefix never matched: the paper scope
// came out empty, readPaperScope returned null, commitSnapshot no-op'd, and the
// shadow version froze. relevantPathsForInput now compares against the resolved
// dir but emits the literal srcDir path the rest of the pipeline expects.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { relevantPathsForInput } from '../server/lib/build-runner.mjs'

// Build the Fly layout: <root>/projects is a symlink to <root>/persist/projects.
function symlinkedProject() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'tlda-relfiles-'))
  const srcReal = join(root, 'persist', 'projects', 'mydoc', 'source')
  mkdirSync(join(srcReal, 'revision', 'appendix_folder'), { recursive: true })
  writeFileSync(join(srcReal, 'revision', 'appendix_folder', 'appendix_b.tex'), '% appendix\n')
  symlinkSync(join(root, 'persist', 'projects'), join(root, 'projects'))
  const srcDir = join(root, 'projects', 'mydoc', 'source') // literal (symlinked) path the server uses
  return { root, srcDir }
}

test('resolves a relative INPUT through the symlinked projects dir (the freeze fix)', () => {
  const { srcDir } = symlinkedProject()
  const dirs = { srcDir, authorDir: undefined, realSrcDir: realpathSync(srcDir), realAuthorDir: undefined }

  const out = relevantPathsForInput('revision/appendix_folder/appendix_b.tex', dirs)

  // Pre-fix this was [] (the freeze). Post-fix it yields the literal srcDir path.
  assert.deepEqual(out, [join(srcDir, 'revision', 'appendix_folder', 'appendix_b.tex')])
  // Must be the literal symlink path, NOT the realpath'd persist path —
  // readPaperScope compares stored paths against the literal srcDir.
  assert.ok(!out[0].includes('/persist/'), `stored a persist/realpath path: ${out[0]}`)
})

test('emits both author and literal srcDir paths when authorDir is set', () => {
  const { srcDir } = symlinkedProject()
  const authorDir = '/Users/skip/work/mydoc' // author machine path; need not exist here
  // realDirOf falls back to the literal dir when it can't be resolved.
  const dirs = { srcDir, authorDir, realSrcDir: realpathSync(srcDir), realAuthorDir: authorDir }

  const out = relevantPathsForInput('revision/appendix_folder/appendix_b.tex', dirs)

  assert.ok(out.includes(join(authorDir, 'revision', 'appendix_folder', 'appendix_b.tex')))
  assert.ok(out.includes(join(srcDir, 'revision', 'appendix_folder', 'appendix_b.tex')))
})

test('skips system / texlive absolute paths', () => {
  const dirs = {
    srcDir: '/x/projects/d/source', authorDir: undefined,
    realSrcDir: '/x/persist/projects/d/source', realAuthorDir: undefined,
  }
  assert.deepEqual(relevantPathsForInput('/usr/share/texlive/tex/latex/base/article.cls', dirs), [])
})

test('matches an absolute INPUT already under the literal srcDir', () => {
  const { srcDir } = symlinkedProject()
  const dirs = { srcDir, authorDir: undefined, realSrcDir: realpathSync(srcDir), realAuthorDir: undefined }
  const abs = join(srcDir, 'revision', 'appendix_folder', 'appendix_b.tex')
  const out = relevantPathsForInput(abs, dirs)
  assert.deepEqual(out, [abs])
})
