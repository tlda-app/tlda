import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { closeProjectStore, createProject, initProjectStore, readProject, readClientSourceManifest } from './project-store.mjs'
import { processProjectPush, setSourceBindingTargetProvider } from '../routes/projects.mjs'
import { linkOverleaf, syncOverleaf, stopPolling } from './overleaf-sync.mjs'

const execFile = promisify(execFileCallback)
const gitEnv = { ...process.env }
for (const key of Object.keys(gitEnv)) {
  if (key.startsWith('GIT_AUTHOR_') || key.startsWith('GIT_COMMITTER_')) delete gitEnv[key]
}

async function git(cwd, ...args) {
  const { stdout } = await execFile('git', args, { cwd, encoding: 'utf8', env: gitEnv })
  return stdout.trim()
}

test('a linked remote never deletes content it did not itself introduce, and still deletes what it removes', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tlda-overleaf-provenance-'))
  const name = 'fixture-remote-provenance'
  t.after(async () => {
    stopPolling(name)
    setSourceBindingTargetProvider(null)
    try { await closeProjectStore() } catch { /* best-effort cleanup, store may already be closed */ }
    await rm(root, { recursive: true, force: true })
  })

  // Bare remote, seeded with two tracked files.
  const bareDir = await mkdtemp(path.join(tmpdir(), 'tlda-overleaf-remote-bare-'))
  await execFile('git', ['init', '--bare', '--initial-branch=main', bareDir])
  const seedDir = await mkdtemp(path.join(tmpdir(), 'tlda-overleaf-remote-seed-'))
  await git(seedDir, 'init', '--initial-branch=main')
  await git(seedDir, 'config', 'user.name', 'remote')
  await git(seedDir, 'config', 'user.email', 'remote@example.test')
  await writeFile(path.join(seedDir, 'main.tex'), 'remote v1\n')
  await writeFile(path.join(seedDir, 'refs.bib'), 'ref v1\n')
  await git(seedDir, 'add', '-A')
  await git(seedDir, 'commit', '-m', 'seed')
  await git(seedDir, 'remote', 'add', 'origin', bareDir)
  await git(seedDir, 'push', 'origin', 'main')

  await initProjectStore(root)
  setSourceBindingTargetProvider(() => [])

  // Project already exists with local-only content the remote never had —
  // the Bregman shape: a scratch/backup file that was never round-tripped
  // through the linked remote.
  createProject({ name, mainFile: 'main.tex', format: 'svg' })
  const localPush = await processProjectPush(name, {
    project: name, requestId: 'R-local-1', deliveryId: 'D-local-1',
    expectedRevision: null,
    files: [{ path: 'main.tex', content: 'local seed\n' }, { path: 'scratch.bak.tex', content: 'never pushed anywhere\n' }],
    deletedFiles: [], sourceManifest: ['main.tex', 'scratch.bak.tex'], editedBy: 'skip',
  })
  assert.equal(localPush.ok, true, JSON.stringify(localPush))

  // Link to the remote. The initial sync must not delete scratch.bak.tex —
  // the remote never had it and has no claim over it.
  await linkOverleaf(name, { gitUrl: bareDir, mainFile: 'main.tex', format: 'svg', pollSeconds: 3600 })

  const afterLink = await readClientSourceManifest(name)
  assert.deepEqual([...afterLink].sort(), ['main.tex', 'refs.bib', 'scratch.bak.tex'].sort(), 'initial link must union remote content with pre-existing local-only content, not replace it')

  const projectAfterLink = await readProject(name)
  assert.deepEqual([...(projectAfterLink.overleafSourceManifest || [])].sort(), ['main.tex', 'refs.bib'], 'baseline must be exactly what the remote has, not the unioned authority')

  // Second pull: the remote genuinely removes refs.bib and changes main.tex.
  // scratch.bak.tex is still absent from the remote (it always has been) and
  // must NOT be deleted by this pull.
  await git(seedDir, 'rm', 'refs.bib')
  await writeFile(path.join(seedDir, 'main.tex'), 'remote v2\n')
  await git(seedDir, 'add', '-A')
  await git(seedDir, 'commit', '-m', 'remove refs, change main')
  await git(seedDir, 'push', 'origin', 'main')

  const summary = await syncOverleaf(name)
  assert.equal(summary.unchanged, undefined, JSON.stringify(summary))

  const afterSecondSync = await readClientSourceManifest(name)
  assert.deepEqual([...afterSecondSync].sort(), ['main.tex', 'scratch.bak.tex'], 'refs.bib (a real remote removal) is gone; scratch.bak.tex (never the remote\'s) survives')

  const projectAfterSecondSync = await readProject(name)
  assert.deepEqual([...(projectAfterSecondSync.overleafSourceManifest || [])].sort(), ['main.tex'], 'baseline updates to the remote\'s new tree')

  await rm(bareDir, { recursive: true, force: true })
  await rm(seedDir, { recursive: true, force: true })
})
