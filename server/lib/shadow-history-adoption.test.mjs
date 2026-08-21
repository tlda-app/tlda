import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { adoptShadowHistoryRef } from './build-runner.mjs'
import { setProjectPathOverride } from './project-store.mjs'

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

test('adopting the existing shadow head is an idempotent retry, but divergent history is rejected', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-shadow-adopt-retry-'))
  const name = 'adopt-retry'
  const projectDir = join(root, name)
  const sourceDir = join(root, 'source')
  const shadowDir = join(projectDir, 'shadow-repo')
  mkdirSync(sourceDir, { recursive: true })
  mkdirSync(projectDir, { recursive: true })
  setProjectPathOverride(name, projectDir)
  t.after(() => {
    setProjectPathOverride(name)
    rmSync(root, { recursive: true, force: true })
  })

  git(sourceDir, 'init')
  git(sourceDir, 'config', 'user.email', 'tlda@test.invalid')
  git(sourceDir, 'config', 'user.name', 'tlda test')
  writeFileSync(join(sourceDir, 'paper.tex'), 'first\n')
  git(sourceDir, 'add', 'paper.tex')
  git(sourceDir, 'commit', '-m', 'first')
  const head = git(sourceDir, 'rev-parse', 'HEAD')
  const ref = `refs/tlda/history-seeds/mini-testing/${head}`
  git(sourceDir, 'update-ref', ref, head)

  assert.equal(await adoptShadowHistoryRef({ name, gitDir: join(sourceDir, '.git'), ref, head }), true)
  assert.equal(git(shadowDir, 'rev-parse', 'HEAD'), head)
  assert.equal(await adoptShadowHistoryRef({ name, gitDir: join(sourceDir, '.git'), ref, head }), true)
  writeFileSync(join(sourceDir, 'paper.tex'), 'second\n')
  git(sourceDir, 'commit', '-am', 'second')
  const divergentHead = git(sourceDir, 'rev-parse', 'HEAD')
  const divergentRef = `refs/tlda/history-seeds/mini-testing/${divergentHead}`
  git(sourceDir, 'update-ref', divergentRef, divergentHead)
  await assert.rejects(
    adoptShadowHistoryRef({ name, gitDir: join(sourceDir, '.git'), ref: divergentRef, head: divergentHead }),
    /already has version history on this server/
  )
})
