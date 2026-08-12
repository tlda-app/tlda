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
  outputDir,
  projectDir,
  readProject,
  readSourceFile,
  sourceDir,
  sourceLifecycleStore,
  updateClientSourceManifest,
  updateProject,
} from '../server/lib/project-store.mjs'
import { readEditEvents } from '../server/lib/edit-events.mjs'
import { linkOverleaf, stopPolling, unlinkOverleaf } from '../server/lib/overleaf-sync.mjs'
import { processProjectPush } from '../server/routes/projects.mjs'

const gitEnv = { ...process.env }
for (const key of Object.keys(gitEnv)) {
  if (key.startsWith('GIT_AUTHOR_') || key.startsWith('GIT_COMMITTER_')) {
    delete gitEnv[key]
  }
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function seedRemote(root, { main = 'base main\n', notes = null } = {}) {
  const remote = path.join(root, 'remote.git')
  const seed = path.join(root, 'seed')
  fs.mkdirSync(seed)
  git(['init'], seed)
  git(['config', 'user.email', 'test@example.invalid'], seed)
  git(['config', 'user.name', 'test'], seed)
  write(path.join(seed, 'main.tex'), main)
  const files = ['main.tex']
  if (notes !== null) {
    write(path.join(seed, 'notes.tex'), notes)
    files.push('notes.tex')
  }
  git(['add', ...files], seed)
  git(['commit', '-m', 'base'], seed)
  git(['init', '--bare', remote], root)
  git(['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/master'], root)
  git(['remote', 'add', 'origin', remote], seed)
  git(['push', '-u', 'origin', 'HEAD:master'], seed)
  return remote
}

async function setupLinkedProject(root, { name, remote, files }) {
  createProject({ name, title: name, mainFile: 'main.tex', format: 'svg' })
  await updateProject(name, { pages: 1, buildStatus: 'success', overleafRemote: remote, autoSync: true })
  for (const [filePath, content] of Object.entries(files)) {
    write(path.join(sourceDir(name), filePath), content)
  }
  const sourceManifest = Object.keys(files).sort()
  await updateClientSourceManifest(name, sourceManifest)
  const lifecycle = await sourceLifecycleStore(name)
  const bootstrapped = lifecycle.bootstrap({
    expectedRevision: null,
    sourceManifest,
    files: sourceManifest.map(filePath => ({ path: filePath, content: files[filePath] })),
  })
  assert.equal(bootstrapped.ok, true)

  const clone = path.join(projectDir(name), 'overleaf-clone')
  git(['clone', remote, clone], root)
  git(['config', 'user.email', 'test@example.invalid'], clone)
  git(['config', 'user.name', 'test'], clone)

  return { lifecycle, acceptedAuthority: lifecycle.readAuthority() }
}

function advanceRemote(root, remote, { filePath, content, message = 'remote edit' }) {
  const remoteEditor = path.join(root, `remote-editor-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  git(['clone', remote, remoteEditor], root)
  git(['config', 'user.email', 'remote@example.invalid'], remoteEditor)
  git(['config', 'user.name', 'remote editor'], remoteEditor)
  write(path.join(remoteEditor, filePath), content)
  git(['add', filePath], remoteEditor)
  git(['commit', '-m', message], remoteEditor)
  git(['push', 'origin', 'HEAD:master'], remoteEditor)
  return git(['--git-dir', remote, 'rev-parse', 'refs/heads/master'], root)
}

function remoteFile(root, remote, filePath) {
  return git(['--git-dir', remote, 'show', `master:${filePath}`], root)
}

function seedRemoteHistory(root) {
  const remote = path.join(root, 'history.git')
  const seed = path.join(root, 'history-seed')
  fs.mkdirSync(seed)
  git(['init'], seed)
  git(['config', 'user.email', 'first@example.invalid'], seed)
  git(['config', 'user.name', 'first author'], seed)
  write(path.join(seed, 'main.tex'), 'one\n')
  git(['add', 'main.tex'], seed)
  git(['commit', '-m', 'one'], seed)
  git(['config', 'user.email', 'second@example.invalid'], seed)
  git(['config', 'user.name', 'second author'], seed)
  write(path.join(seed, 'main.tex'), 'two\n')
  git(['add', 'main.tex'], seed)
  git(['commit', '-m', 'two'], seed)
  git(['config', 'user.email', 'third@example.invalid'], seed)
  git(['config', 'user.name', 'third author'], seed)
  write(path.join(seed, 'notes.tex'), 'notes\n')
  git(['add', 'notes.tex'], seed)
  git(['commit', '-m', 'notes'], seed)
  git(['config', 'user.email', 'fourth@example.invalid'], seed)
  git(['config', 'user.name', 'fourth author'], seed)
  write(path.join(seed, 'main.tex'), 'four\n')
  git(['add', 'main.tex'], seed)
  git(['commit', '-m', 'four'], seed)
  git(['init', '--bare', remote], root)
  git(['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/master'], root)
  git(['remote', 'add', 'origin', remote], seed)
  git(['push', '-u', 'origin', 'HEAD:master'], seed)
  return remote
}

// If this fails, Skip loses the proof that tlda will not overwrite a concurrent
// Overleaf edit to the same file with stale browser text.
test('overlapping remote and browser edits preserve both sides and accepted authority', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-linked-remote-divergence-'))
  try {
    await initProjectStore(root)
    const name = 'linked-remote-divergence'
    const remote = seedRemote(root)
    const { lifecycle, acceptedAuthority } = await setupLinkedProject(root, {
      name,
      remote,
      files: { 'main.tex': 'base main\n' },
    })
    const remoteHead = advanceRemote(root, remote, { filePath: 'main.tex', content: 'remote side\n' })

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
    assert.equal(remoteFile(root, remote, 'main.tex'), 'remote side')
    const project = await readProject(name)
    assert.equal(project.overleafSyncStatus, 'conflict')
    assert.deepEqual(project.overleafConflictFiles, ['main.tex'])
  } finally {
    await closeProjectStore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// If this fails, Skip loses a collaborator's Overleaf edit on one file when tlda
// pushes a different file from the browser.
test('non-overlapping remote and browser edits publish on top of each other', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-linked-remote-concurrent-'))
  try {
    await initProjectStore(root)
    const name = 'linked-remote-concurrent'
    const remote = seedRemote(root, { notes: 'base notes\n' })
    const { acceptedAuthority } = await setupLinkedProject(root, {
      name,
      remote,
      files: { 'main.tex': 'base main\n', 'notes.tex': 'base notes\n' },
    })
    write(path.join(outputDir(name), 'relevant-files.json'), JSON.stringify({ files: ['unrelated.tex'] }))
    const remoteHead = advanceRemote(root, remote, { filePath: 'notes.tex', content: 'remote notes\n' })

    const result = await processProjectPush(name, {
      expectedRevision: acceptedAuthority.currentRevision,
      files: [{ path: 'main.tex', content: 'browser main\n' }],
      sourceManifest: ['main.tex', 'notes.tex'],
    })

    assert.equal(result.status, 200)
    assert.equal(remoteFile(root, remote, 'main.tex'), 'browser main')
    assert.equal(remoteFile(root, remote, 'notes.tex'), 'remote notes')
    const nextRemoteHead = git(['--git-dir', remote, 'rev-parse', 'refs/heads/master'], root)
    assert.notEqual(nextRemoteHead, remoteHead)
    assert.equal(readSourceFile(name, 'main.tex'), 'browser main\n')
    assert.equal(readSourceFile(name, 'notes.tex'), 'base notes\n')
    const project = await readProject(name)
    assert.equal(project.overleafHead, nextRemoteHead)
    assert.equal(project.overleafSyncStatus, 'ok')
    assert.deepEqual(project.overleafConflictFiles, [])
  } finally {
    await closeProjectStore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// If this fails, Skip sees a four-commit Overleaf history collapse to one tlda
// version and cannot tell which collaborator changed which file.
test('initial link imports each remote commit as edit history', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-linked-remote-history-'))
  const name = 'linked-remote-history'
  try {
    await initProjectStore(root)
    const remote = seedRemoteHistory(root)
    createProject({ name, title: name, mainFile: 'main.tex', format: 'svg' })
    await updateProject(name, { pages: 1, buildStatus: 'success' })
    write(path.join(outputDir(name), 'relevant-files.json'), JSON.stringify({ files: ['unrelated.tex'] }))

    const result = await linkOverleaf(name, { gitUrl: remote, mainFile: 'main.tex', pollSeconds: 999 })

    assert.equal(result.linked, true)
    assert.equal(readSourceFile(name, 'main.tex'), 'four\n')
    assert.equal(readSourceFile(name, 'notes.tex'), 'notes\n')
    let history = await readEditEvents(name)
    const remoteCommits = git(['--git-dir', remote, 'log', '--reverse', '--format=%H', 'master'], root).split('\n')
    assert.deepEqual(history.events.map(event => event.attribution_basis.commit_hash), remoteCommits)
    assert.deepEqual(history.events.map(event => event.actor_display_name), [
      'first author',
      'second author',
      'third author',
      'fourth author',
    ])
    assert.equal(history.events.length, 4)

    await unlinkOverleaf(name, { gitUrl: remote })
    const relink = await linkOverleaf(name, { gitUrl: remote, mainFile: 'main.tex', pollSeconds: 999 })
    assert.equal(relink.linked, true)
    history = await readEditEvents(name)
    assert.deepEqual(new Set(history.events.map(event => event.attribution_basis.commit_hash)), new Set(remoteCommits))
  } finally {
    stopPolling(name)
    await closeProjectStore()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
