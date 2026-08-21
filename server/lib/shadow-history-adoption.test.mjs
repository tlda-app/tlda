import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { adoptShadowHistory } from './build-runner.mjs'
import { setProjectPathOverride } from './project-store.mjs'

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

test('adopting the existing shadow head is an idempotent retry, but divergent history is rejected', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-shadow-adopt-retry-'))
  const name = 'adopt-retry'
  const projectDir = join(root, name)
  const shadowDir = join(projectDir, 'shadow-repo')
  mkdirSync(shadowDir, { recursive: true })
  setProjectPathOverride(name, projectDir)
  t.after(() => {
    setProjectPathOverride(name)
    rmSync(root, { recursive: true, force: true })
  })

  git(shadowDir, 'init')
  git(shadowDir, 'config', 'user.email', 'tlda@test.invalid')
  git(shadowDir, 'config', 'user.name', 'tlda test')
  writeFileSync(join(shadowDir, 'paper.tex'), 'first\n')
  git(shadowDir, 'add', 'paper.tex')
  git(shadowDir, 'commit', '-m', 'first')
  const head = git(shadowDir, 'rev-parse', 'HEAD')

  assert.equal(await adoptShadowHistory({ name, bundleBase64: 'not-read-on-retry', head }), true)
  await assert.rejects(
    adoptShadowHistory({ name, bundleBase64: 'not-read-on-divergence', head: '0'.repeat(40) }),
    /already has version history on this server/
  )
})
