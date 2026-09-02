/**
 * A failed build must leave an account of itself that the reader can find.
 *
 * The log was already being written and carried out of the build instance. What
 * was missing was a reader: `extractBuildErrors` looked only at `latex.log`,
 * which latexmk alone produces, so every non-LaTeX failure answered
 * `logMissing: true` while its `build.log` sat in the project directory.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  closeProjectStore,
  createProject,
  extractBuildErrors,
  initProjectStore,
  setProjectPathOverride,
} from './project-store.mjs'
import { publishBuildDiagnostics } from './build-dispatch.mjs'

test('a failed non-LaTeX build reports its reason instead of reporting no log', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-build-log-readable-'))
  await initProjectStore(root)
  t.after(async () => {
    setProjectPathOverride('deck')
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  })
  createProject({ name: 'deck', mainFile: 'index.qmd', format: 'qmd' })

  // The counterfactual first: no log of either kind is still an absent log.
  assert.deepEqual(await extractBuildErrors('deck'), { errors: [], warnings: [], logMissing: true })

  // What `withBuildLog` actually writes — the builder's own progress lines, and
  // the `[build] ` line its catch appends. No latex.log, because a .qmd build
  // never produces one.
  writeFileSync(join(root, 'deck', 'build.log'),
    '[qmd] rendering index.qmd\n[build] render produced neither index.html nor _book/index.html\n')

  const result = await extractBuildErrors('deck')
  assert.equal(result.logMissing, false, 'the log is there; it must not be reported missing')
  assert.deepEqual(result.errors, [
    { message: 'render produced neither index.html nor _book/index.html' },
  ])
  // The builder's progress line is not an error.
  assert.equal(result.warnings.length, 0)
})

test('latex.log still wins where there is one', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-build-log-latex-'))
  await initProjectStore(root)
  t.after(async () => { await closeProjectStore(); rmSync(root, { recursive: true, force: true }) })
  createProject({ name: 'paper', mainFile: 'main.tex' })
  writeFileSync(join(root, 'paper', 'latex.log'), '! Undefined control sequence.\nl.5 \\undefinedcommand\n')
  writeFileSync(join(root, 'paper', 'build.log'), '[build] should not be read for a LaTeX project\n')

  const result = await extractBuildErrors('paper')
  assert.equal(result.logMissing, false)
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0].message, /Undefined control sequence/)
})

test('a failure with no build instance still leaves its reason in the live project', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-build-log-no-instance-'))
  await initProjectStore(root)
  t.after(async () => { await closeProjectStore(); rmSync(root, { recursive: true, force: true }) })
  createProject({ name: 'deck', mainFile: 'index.qmd', format: 'qmd' })

  // instanceProject null: the shape of every failure that happens before
  // materializeBuildInstance returns. Gated on the instance, this wrote nothing.
  const { copied, wrote } = publishBuildDiagnostics('deck', null, 'requires an immutable source revision')
  assert.deepEqual(copied, [])
  assert.equal(wrote, 'build.log')

  const result = await extractBuildErrors('deck')
  assert.equal(result.logMissing, false)
  assert.deepEqual(result.errors, [{ message: 'requires an immutable source revision' }])
})

test('an instance log is carried out and retains the outer worker failure', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-build-log-instance-wins-'))
  await initProjectStore(root)
  t.after(async () => { await closeProjectStore(); rmSync(root, { recursive: true, force: true }) })
  createProject({ name: 'deck', mainFile: 'index.qmd', format: 'qmd' })

  const instance = join(root, 'private-instance', 'deck')
  mkdirSync(instance, { recursive: true })
  writeFileSync(join(instance, 'build.log'), '[2026-09-02T23:23:20.000Z] Build complete in 21.7s')

  const { copied, wrote } = publishBuildDiagnostics('deck', instance, 'build worker RPC publishBuildInstance got no answer')
  assert.deepEqual(copied, ['build.log'])
  assert.equal(wrote, 'build.log')
  const log = readFileSync(join(root, 'deck', 'build.log'), 'utf8')
  assert.match(log, /Build complete in 21\.7s/, 'the successful inner build log must remain')
  assert.match(log, /publishBuildInstance got no answer/, 'the outer worker failure must remain too')
  assert.deepEqual((await extractBuildErrors('deck')).errors, [
    { message: 'build worker RPC publishBuildInstance got no answer' },
  ])
})
