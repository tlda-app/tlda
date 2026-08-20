import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createGitSourceManager } from './git-source.mjs'

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function writeCommit(cwd, content, message) {
  fs.writeFileSync(path.join(cwd, 'main.tex'), content)
  git(cwd, 'add', 'main.tex')
  git(cwd, 'commit', '-m', message)
  return git(cwd, 'rev-parse', 'HEAD')
}

function clone(remote, dir) {
  git(path.dirname(dir), 'clone', remote, dir)
  git(dir, 'config', 'user.email', 'test@local')
  git(dir, 'config', 'user.name', 'test')
}

test('Git source converges exact accepted revisions and withholds conflicts and stale pushes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-git-source-'))
  try {
    const remote = path.join(root, 'remote.git')
    git(root, 'init', '--bare', remote)
    const seed = path.join(root, 'seed')
    git(root, 'init', seed)
    git(seed, 'config', 'user.email', 'test@local')
    git(seed, 'config', 'user.name', 'test')
    fs.writeFileSync(path.join(seed, 'refs.bib'), 'remote reference\n')
    git(seed, 'add', 'refs.bib')
    writeCommit(seed, 'base\n', 'base')
    git(seed, 'remote', 'add', 'origin', remote)
    git(seed, 'push', '-u', 'origin', 'HEAD:main')
    git(remote, 'symbolic-ref', 'HEAD', 'refs/heads/main')

    const queued = []
    const manager = createGitSourceManager({
      stateFile: path.join(root, 'git-sources.json'),
      sourcesRoot: path.join(root, 'sources'),
      queuePaths: (project, paths) => queued.push({ project, paths }),
      log: { warn() {} },
    })
    const linked = await manager.link({ project: 'paper', remote, mirrorMode: 'auto-merge', pollSeconds: 15 })
    await manager.activate({ project: 'paper' })
    assert.deepEqual(queued.pop(), { project: 'paper', paths: ['main.tex', 'refs.bib'] })

    const collaborator = path.join(root, 'collaborator')
    clone(remote, collaborator)
    writeCommit(collaborator, 'remote one\n', 'remote one')
    git(collaborator, 'rm', 'refs.bib')
    git(collaborator, 'commit', '-m', 'remove reference')
    const remoteFastForward = git(collaborator, 'rev-parse', 'HEAD')
    git(collaborator, 'push', 'origin', 'HEAD:main')
    fs.writeFileSync(path.join(linked.sourceDir, 'main.tex'), 'unsubmitted local edit\n')
    const dirty = await manager.poll('paper')
    assert.equal(dirty.status, 'working-copy-dirty')
    assert.equal(fs.readFileSync(path.join(linked.sourceDir, 'main.tex'), 'utf8'), 'unsubmitted local edit\n', 'poll must not overwrite an unsubmitted edit')
    git(linked.sourceDir, 'checkout', '--', 'main.tex')
    const pulled = await manager.poll('paper')
    assert.equal(pulled.status, 'fast-forwarded')
    assert.equal(pulled.head, remoteFastForward)
    assert.deepEqual(queued.pop(), { project: 'paper', paths: ['main.tex', 'refs.bib'] })
    assert.equal(fs.existsSync(path.join(linked.sourceDir, 'refs.bib')), false)

    const sourceDir = linked.sourceDir
    const accepted = writeCommit(sourceDir, 'accepted\n', 'accepted')
    await manager.publishAccepted({ project: 'paper', sourceRevision: accepted })
    assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), accepted, 'outbound must push the exact accepted commit')

    git(collaborator, 'fetch', 'origin')
    git(collaborator, 'reset', '--hard', 'origin/main')
    writeCommit(collaborator, 'remote conflict\n', 'remote conflict')
    git(collaborator, 'push', 'origin', 'HEAD:main')
    writeCommit(sourceDir, 'local conflict\n', 'local conflict')
    git(sourceDir, 'update-ref', 'refs/tlda/shadow/HEAD', 'HEAD')
    const conflict = await manager.poll('paper')
    assert.equal(conflict.status, 'conflicted')
    const remoteDuringConflict = git(remote, 'rev-parse', 'refs/heads/main')
    const withheld = await manager.publishAccepted({ project: 'paper', sourceRevision: git(sourceDir, 'rev-parse', 'refs/tlda/shadow/HEAD') })
    assert.equal(withheld.status, 'conflicted')
    assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), remoteDuringConflict, 'unresolved checkout must not push')

    git(sourceDir, 'checkout', '--theirs', 'main.tex')
    git(sourceDir, 'add', 'main.tex')
    git(sourceDir, 'commit', '-m', 'resolve')
    const resolved = git(sourceDir, 'rev-parse', 'HEAD')
    await manager.publishAccepted({ project: 'paper', sourceRevision: resolved })
    assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), resolved)

    git(collaborator, 'fetch', 'origin')
    git(collaborator, 'reset', '--hard', 'origin/main')
    const movedRemote = writeCommit(collaborator, 'remote moved again\n', 'remote moved again')
    git(collaborator, 'push', 'origin', 'HEAD:main')
    const stale = await manager.publishAccepted({ project: 'paper', sourceRevision: resolved })
    assert.equal(stale.status, 'remote-diverged')
    assert.equal(git(remote, 'rev-parse', 'refs/heads/main'), movedRemote, 'stale accepted revision must not overwrite the remote')
    manager.close()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
