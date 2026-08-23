import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  closeProjectStore,
  createProject,
  extractBuildErrors,
  initProjectStore,
  setProjectPathOverride,
} from './project-store.mjs'

test('private build error extraction cannot read the stale live project log or source', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-private-build-errors-'))
  const instance = join(root, 'private-instance', 'paper')
  await initProjectStore(root)
  t.after(async () => {
    setProjectPathOverride('paper')
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  })
  createProject({ name: 'paper', mainFile: 'main.tex' })
  writeFileSync(join(root, 'paper', 'latex.log'), '! Stale live error.\nl.1 live\n')
  writeFileSync(join(root, 'paper', 'source', 'main.tex'), 'live source\n')

  mkdirSync(join(instance, 'source'), { recursive: true })
  writeFileSync(join(instance, 'latex.log'), 'Clean private build.\n')
  writeFileSync(join(instance, 'source', 'main.tex'), 'private source\n')
  setProjectPathOverride('paper', instance)

  // logMissing false: this build HAS a log and it is clean. That is a different
  // answer from the one below, and telling them apart is the point of the field.
  assert.deepEqual(await extractBuildErrors('paper'), { errors: [], warnings: [], logMissing: false })
})

test('an absent log is reported as absent, not as a clean build', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-missing-build-log-'))
  await initProjectStore(root)
  t.after(async () => {
    setProjectPathOverride('paper')
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  })
  createProject({ name: 'paper', mainFile: 'main.tex' })
  // No latex.log written at all — a failed build whose log never reached the
  // live project. Before `logMissing` this returned exactly what a clean build
  // returns, which is how `tlda project errors` answered `Clean.` about a build
  // the server was reporting as `error`.
  const result = await extractBuildErrors('paper')
  assert.deepEqual(result, { errors: [], warnings: [], logMissing: true })

  // The counterfactual that makes the assertion above mean something: the same
  // call against a log that IS there must come back logMissing false, or the
  // field would be reporting "missing" for everything and the test would pass
  // without measuring anything.
  writeFileSync(join(root, 'paper', 'latex.log'), '! Undefined control sequence.\nl.5 \\undefinedcommand\n')
  const withLog = await extractBuildErrors('paper')
  assert.equal(withLog.logMissing, false)
  assert.equal(withLog.errors.length, 1)
})
