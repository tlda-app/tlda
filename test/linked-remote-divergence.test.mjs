import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  closeProjectStore,
  createProject,
  initProjectStore,
  projectDir,
  readProject,
  readSourceFile,
  sourceDir,
  sourceLifecycleStore,
  updateClientSourceManifest,
  updateProject,
} from '../server/lib/project-store.mjs'
import { processProjectPush } from '../server/routes/projects.mjs'

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

test('overlapping remote and browser edits preserve both sides and accepted authority', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-linked-remote-divergence-'))
  try {
    await initProjectStore(root)
    const remote = path.join(root, 'remote.git')
    const seed = path.join(root, 'seed')
    fs.mkdirSync(seed)
    git(['init'], seed)
    git(['config', 'user.email', 'test@example.invalid'], seed)
    git(['config', 'user.name', 'test'], seed)
    write(path.join(seed, 'main.tex'), 'base main\n')
    git(['add', 'main.tex'], seed)
    git(['commit', '-m', 'base'], seed)
    git(['init', '--bare', remote], root)
    git(['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/master'], root)
    git(['remote', 'add', 'origin', remote], seed)
    git(['push', '-u', 'origin', 'HEAD:master'], seed)

    const name = 'linked-remote-divergence'
    createProject({ name, title: name, mainFile: 'main.tex', format: 'svg' })
    await updateProject(name, { pages: 1, buildStatus: 'success', overleafRemote: remote, autoSync: true })
    write(path.join(sourceDir(name), 'main.tex'), 'base main\n')
    await updateClientSourceManifest(name, ['main.tex'])
    const lifecycle = await sourceLifecycleStore(name)
    const bootstrapped = lifecycle.bootstrap({
      expectedRevision: null,
      sourceManifest: ['main.tex'],
      files: [{ path: 'main.tex', content: 'base main\n' }],
    })
    assert.equal(bootstrapped.ok, true)
    const acceptedAuthority = lifecycle.readAuthority()

    const clone = path.join(projectDir(name), 'overleaf-clone')
    git(['clone', remote, clone], root)
    git(['config', 'user.email', 'test@example.invalid'], clone)
    git(['config', 'user.name', 'test'], clone)

    const remoteEditor = path.join(root, 'remote-editor')
    git(['clone', remote, remoteEditor], root)
    git(['config', 'user.email', 'remote@example.invalid'], remoteEditor)
    git(['config', 'user.name', 'remote editor'], remoteEditor)
    write(path.join(remoteEditor, 'main.tex'), 'remote side\n')
    git(['add', 'main.tex'], remoteEditor)
    git(['commit', '-m', 'remote edit'], remoteEditor)
    git(['push', 'origin', 'HEAD:master'], remoteEditor)
    const remoteHead = git(['--git-dir', remote, 'rev-parse', 'refs/heads/master'], root)

    const result = await processProjectPush(name, {
      expectedRevision: acceptedAuthority.currentRevision,
      files: [{ path: 'main.tex', content: 'browser side\n' }],
      sourceManifest: ['main.tex'],
    })

    assert.equal(result.status, 409)
    assert.equal(result.lifecycleStatus, 'overleaf-conflict')
    assert.deepEqual(result.conflictFiles, ['main.tex'])
    assert.deepEqual(lifecycle.readAuthority(), acceptedAuthority)
    assert.equal(readSourceFile(name, 'main.tex'), 'base main\n')
    assert.equal(git(['--git-dir', remote, 'rev-parse', 'refs/heads/master'], root), remoteHead)
    assert.equal(git(['--git-dir', remote, 'show', 'master:main.tex'], root), 'remote side')
    const project = await readProject(name)
    assert.equal(project.overleafSyncStatus, 'conflict')
    assert.deepEqual(project.overleafConflictFiles, ['main.tex'])
  } finally {
    await closeProjectStore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
