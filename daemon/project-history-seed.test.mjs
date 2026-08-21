import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createShadowMirror, exportProjectHistoryBundle } from './shadow-mirror.mjs'

const execFile = promisify(execFileCb)
const git = (cwd, args) => execFile('git', args, { cwd, encoding: 'utf8', timeout: 120000 })

async function fixtureRepo(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  await git(repo, ['init', '-b', 'main'])
  await git(repo, ['config', 'user.name', 'fixture'])
  await git(repo, ['config', 'user.email', 'fixture@example.test'])
  return { root, repo }
}

async function readBundle(bundleBase64, root) {
  const bundle = join(root, 'history.bundle')
  const imported = join(root, 'imported')
  writeFileSync(bundle, Buffer.from(bundleBase64, 'base64'))
  mkdirSync(imported)
  await git(imported, ['init'])
  await git(imported, ['fetch', bundle, 'refs/tlda/shadow/HEAD:refs/heads/main'])
  return imported
}

test('new-to-tlda link history uses the selected revision and document include graph', async () => {
  const { root, repo } = await fixtureRepo('tlda-project-history-')
  writeFileSync(join(repo, 'paper.tex'), '\\documentclass{article}\n\\input{section}\n')
  writeFileSync(join(repo, 'section.tex'), 'first\n')
  writeFileSync(join(repo, 'notes.txt'), 'unrelated\n')
  await git(repo, ['add', '.'])
  await git(repo, ['commit', '-m', 'initial paper'])
  writeFileSync(join(repo, 'section.tex'), 'second\n')
  await git(repo, ['commit', '-am', 'revise included section'])
  const selected = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim()
  writeFileSync(join(repo, 'notes.txt'), 'later unrelated\n')
  await git(repo, ['commit', '-am', 'later unrelated work'])

  const exported = await exportProjectHistoryBundle({
    project: 'paper', sourceDir: repo, seedBranch: 'main', seedRevision: selected, documentRoots: ['paper.tex'], log: { info() {} },
  })
  assert.equal(exported.empty, false)
  assert.equal(exported.seed, selected)
  assert.deepEqual(exported.members, ['paper.tex', 'section.tex'])

  const imported = await readBundle(exported.bundleBase64, root)
  assert.equal(Number((await git(imported, ['rev-list', '--count', 'main'])).stdout.trim()), 2)
  assert.deepEqual((await git(imported, ['ls-tree', '-r', '--name-only', 'main'])).stdout.trim().split('\n'), ['paper.tex', 'section.tex'])
  assert.equal((await git(imported, ['show', 'main:section.tex'])).stdout, 'second\n')
})

test('existing tlda shadow history takes precedence over ordinary Git seeding', async () => {
  const { root, repo } = await fixtureRepo('tlda-existing-shadow-')
  writeFileSync(join(repo, 'paper.tex'), 'paper\n')
  await git(repo, ['add', '.'])
  await git(repo, ['commit', '-m', 'author history'])
  const shadow = (await git(repo, ['commit-tree', 'HEAD^{tree}', '-m', 'existing tlda version'])).stdout.trim()
  await git(repo, ['update-ref', 'refs/tlda/shadow/HEAD', shadow])

  const mirror = createShadowMirror({ getSourceDir: () => repo, log: { info() {}, warn() {} } })
  const exported = await mirror.exportShadowBundle({
    project: 'paper', sourceDir: repo, seedRevision: 'does-not-exist', documentRoots: ['missing.tex'],
  })
  const imported = await readBundle(exported.bundleBase64, root)
  assert.equal((await git(imported, ['rev-parse', 'main'])).stdout.trim(), shadow)
})
