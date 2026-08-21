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

  assert.deepEqual(await extractBuildErrors('paper'), { errors: [], warnings: [] })
})
