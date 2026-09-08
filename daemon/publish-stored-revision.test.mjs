// Publishing a stored revision must not touch the checkout it reads from.
//
// The whole reason this exists is that `submit` publishes the WORKING TREE, so
// republishing an already-accepted revision through it would mean putting that
// revision into somebody's working directory first. The properties below are
// what make this usable on a checkout its owner is in the middle of editing, so
// each is asserted rather than assumed: the branch, `HEAD`, the index, the
// uncommitted edit, and the binding all have to come out the far side unchanged.
//
// The remote is a real bare repository and the push is a real push. A stub
// standing in for the remote would prove the manager calls something and leave
// the only interesting question -- whether the named commit actually lands --
// unasked.

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createGitSyncManager } from './git-sync-manager.mjs'

const execFile = promisify(execFileCb)
const git = async (cwd, args) => (await execFile('git', args, { cwd, encoding: 'utf8', timeout: 30000 })).stdout.trim()

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tlda-publish-stored-revision-'))
  const remote = join(root, 'server.git')
  const checkout = join(root, 'checkout')
  const bindingsFile = join(root, 'bindings.json')
  await git(root, ['init', '--bare', remote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])

  writeFileSync(join(checkout, 'main.tex'), 'accepted\n')
  await git(checkout, ['add', '.'])
  await git(checkout, ['commit', '-m', 'the accepted revision'])
  const accepted = await git(checkout, ['rev-parse', 'HEAD'])

  // The owner has moved on since: a later commit, their own branch, and an
  // uncommitted edit. This is the state that blocks `submit` and must not block
  // this.
  await git(checkout, ['checkout', '-q', '-b', 'owners-branch'])
  writeFileSync(join(checkout, 'main.tex'), 'later work\n')
  await git(checkout, ['commit', '-qam', 'work after the accepted revision'])
  writeFileSync(join(checkout, 'main.tex'), 'uncommitted edit\n')
  writeFileSync(join(checkout, 'untracked.txt'), 'untracked\n')

  writeFileSync(bindingsFile, JSON.stringify({
    paper: { sourceDir: checkout, bindingId: 'paper-binding', documentRoots: ['main.tex'] },
  }, null, 2))

  const manager = createGitSyncManager({
    bindingsFile,
    daemonId: 'daemon-a',
    server: 'http://127.0.0.1:1',
    remoteUrlFor: () => remote,
    watch: () => ({ on: () => {}, close: () => {} }),
    log: { log() {}, warn() {}, error() {} },
  })
  return { root, remote, checkout, bindingsFile, manager, accepted }
}

async function state(checkout) {
  return {
    head: await git(checkout, ['rev-parse', 'HEAD']),
    branch: await git(checkout, ['rev-parse', '--abbrev-ref', 'HEAD']),
    status: await git(checkout, ['status', '--porcelain']),
    working: readFileSync(join(checkout, 'main.tex'), 'utf8'),
  }
}

test('publishRevision publishes the named stored commit', async () => {
  const { remote, checkout, manager, accepted } = await fixture()
  const result = await manager.publishRevision('paper', accepted)
  await manager.closeAll()

  assert.equal(result.revision, accepted, 'the submission must name the revision it was asked for')
  assert.equal(await git(remote, ['rev-parse', result.proposalRef]), accepted,
    'the commit that reached the remote must be the stored revision, not the checkout head')

  // Not the head: the assertion above passes trivially if the fixture ever
  // stops moving on, and then this test would be checking nothing.
  assert.notEqual(accepted, await git(checkout, ['rev-parse', 'refs/heads/owners-branch']),
    'fixture must publish a revision that is NOT the current head')
})

test('publishRevision leaves the checkout exactly as it found it', async () => {
  const { checkout, bindingsFile, manager, accepted } = await fixture()
  const before = await state(checkout)
  const bindingBefore = readFileSync(bindingsFile, 'utf8')

  await manager.publishRevision('paper', accepted)
  await manager.closeAll()

  const after = await state(checkout)
  assert.equal(after.head, before.head, 'HEAD must not move')
  assert.equal(after.branch, 'owners-branch', "the owner's branch must stay checked out")
  assert.equal(after.status, before.status, 'the index and untracked files must be untouched')
  assert.equal(after.working, 'uncommitted edit\n', 'the uncommitted edit must survive verbatim')
  assert.equal(readFileSync(bindingsFile, 'utf8'), bindingBefore, 'the source binding must not be rewritten')
})

test('publishRevision refuses a revision the repository does not hold', async () => {
  const { manager } = await fixture()
  await assert.rejects(
    () => manager.publishRevision('paper', '0'.repeat(40)),
    /is not present in the repository bound to paper/,
    'an absent revision must fail loudly rather than publish something else',
  )
  await manager.closeAll()
})

test('publishRevision publishes nothing when the revision does not descend from the accepted head', async () => {
  // The defect this exists for: the server rejects a proposal that does not
  // descend from the accepted head, and `pushRevision`'s recovery -- correct
  // for a person's edit that raced the server -- combines the two and publishes
  // a commit nobody named, authored as the checkout's owner. A republication
  // must publish one exact commit or nothing.
  const { remote, checkout, manager, accepted } = await fixture()

  // The server's ancestry rule, in the words the client parses.
  writeFileSync(join(remote, 'hooks', 'update'), `#!/bin/sh
head=$(git rev-parse refs/tlda/accepted 2>/dev/null) || exit 0
[ -z "$head" ] && exit 0
if git merge-base --is-ancestor "$head" "$3"; then exit 0; fi
echo "WrongHead $head" >&2
exit 1
`, { mode: 0o755 })
  const laterHead = await git(checkout, ['rev-parse', 'owners-branch'])
  await git(checkout, ['push', '-q', remote, `${laterHead}:refs/tlda/accepted`])

  const refsBefore = await git(checkout, ['for-each-ref', '--format=%(refname) %(objectname)'])
  await assert.rejects(
    () => manager.publishRevision('paper', accepted),
    /Nothing was published/,
    'a revision that cannot be published exactly must fail loudly',
  )
  await manager.closeAll()

  const proposals = await git(remote, ['for-each-ref', '--format=%(refname)', 'refs/tlda/proposals'])
  assert.equal(proposals, '', 'nothing may reach the remote')
  assert.equal(await git(checkout, ['for-each-ref', '--format=%(refname) %(objectname)']), refsBefore,
    'a call that published nothing must not have moved a ref either')
})

test('publishRevision refuses a project that is not bound here', async () => {
  const { manager, accepted } = await fixture()
  await assert.rejects(
    () => manager.publishRevision('not-bound', accepted),
    /is not bound on this daemon/,
  )
  await manager.closeAll()
})
