/**
 * **A fresh source room's branch starts at the project's head, not at nothing.**
 *
 * `standOnWorkBranch` already says this in its own comment — *"a fresh checkout
 * of a project starts at the project's head… the source editor's case: its tree
 * is created empty and it is another daemon like any other"*. It read the head
 * from `refs/tlda/fetched/<project>`, which is a LOCAL ref that exists only once
 * something has fetched — and on a brand-new room nothing has, because
 * `ensureRepo` runs `git init` and stops.
 *
 * So the read answered null for exactly the case it was written for, the branch
 * was born unborn, and the room's first commit was a **root commit unrelated to
 * the project**.
 *
 * **What that cost, measured on deployed `594900c02`.** Every proposal from that
 * room was rejected `WrongHead`, and the rescue path could not help either:
 * `merge-tree --write-tree` on unrelated histories exits **128**, and
 * `pushRevision` rethrows anything that is not exit 1, so the settle threw after
 * `submitFiles` had already answered the browser `202 queued`. Two distinct
 * browser saves were accepted and never published; the bytes sat committed in
 * `.source-room/working` on the server, reachable by nobody.
 *
 * `--allow-unrelated-histories` is NOT the repair and is deliberately not used:
 * it exits 1 with **conflict markers**, because without a merge base every
 * difference is a conflict. That converts a silent loss into a permanent hold —
 * still no browser save ever lands.
 *
 * The controls carry the weight here. Starting a branch from a fetched head must
 * not change the two cases that already worked: a genuinely NEW project, which
 * has no shared head to start from, and a checkout that already has the person's
 * own history.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { createGitProjectSync } from './git-project-sync.mjs'

const execFile = promisify(execFileCb)
const git = (cwd, args) => execFile('git', args, { cwd, encoding: 'utf8', timeout: 30_000 })
const quiet = { info() {}, warn() {}, error() {} }

/** A server-side bare repo already holding an accepted head for `project`. */
async function projectWithAcceptedHead(root, project) {
  const remote = join(root, 'server.git')
  const seed = join(root, 'seed')
  await git(root, ['init', '--bare', '-b', 'main', remote])
  await git(root, ['init', '-b', 'main', seed])
  await git(seed, ['config', 'user.email', 'seed@tlda'])
  await git(seed, ['config', 'user.name', 'seed'])
  writeFileSync(join(seed, 'main.md'), '# paper\n\naccepted content\n')
  await git(seed, ['add', '-A'])
  await git(seed, ['commit', '-qm', 'accepted'])
  const head = (await git(seed, ['rev-parse', 'HEAD'])).stdout.trim()
  await git(seed, ['push', '-q', remote, `HEAD:refs/tlda/source/${project}`])
  return { remote, head }
}

/** The room: an empty repo, exactly what `ensureRepo` leaves behind. */
function emptyRoom(root, name = 'working') {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

const syncOver = (dir, project, remote) => createGitProjectSync({
  sourceDir: dir,
  project,
  daemonId: `source-room:${project}`,
  bindingId: project,
  remote,
  documentRoots: [],
  log: quiet,
})

test('a fresh room with no commits starts its branch at the project head', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-fresh-room-'))
  const project = 'paper'
  const { remote, head } = await projectWithAcceptedHead(root, project)
  const room = emptyRoom(root)
  await git(root, ['init', '-b', 'main', room])
  await git(room, ['config', 'user.email', 'tlda@local'])
  await git(room, ['config', 'user.name', 'tlda source daemon'])

  // Precondition: nothing has fetched, so the local fetched ref does NOT exist.
  // Without it the old code read null here and created an unborn branch.
  const before = await git(room, ['rev-parse', '--verify', '--quiet', `refs/tlda/fetched/${project}`])
    .then(r => r.stdout.trim(), () => '')
  assert.equal(before, '', 'the fixture really is the unfetched case this is about')

  const stood = await syncOver(room, project, remote).standOnWorkBranch()
  assert.equal(stood.ok, true, `standing on the work branch must succeed: ${JSON.stringify(stood)}`)

  const roomHead = (await git(room, ['rev-parse', 'HEAD'])).stdout.trim()
  assert.equal(roomHead, head,
    'the room starts AT the project head — the same commit a clone would give you')

  // The property the whole defect turned on: the histories are RELATED, so a
  // proposal descends from the accepted head and `merge-tree` has a base.
  await execFile('git', ['merge-base', '--is-ancestor', head, 'HEAD'], { cwd: room, timeout: 30_000 })
})

test('and its first commit therefore descends from the accepted head', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-fresh-room-commit-'))
  const project = 'paper'
  const { remote, head } = await projectWithAcceptedHead(root, project)
  const room = emptyRoom(root)
  await git(root, ['init', '-b', 'main', room])
  await git(room, ['config', 'user.email', 'tlda@local'])
  await git(room, ['config', 'user.name', 'tlda source daemon'])
  await syncOver(room, project, remote).standOnWorkBranch()

  // What a browser save does: write the file, commit it on the work branch.
  writeFileSync(join(room, 'main.md'), '# paper\n\naccepted content\n\nbrowser editor line\n')
  await git(room, ['add', '-A'])
  await git(room, ['commit', '-qm', 'browser save'])

  await execFile('git', ['merge-base', '--is-ancestor', head, 'HEAD'], { cwd: room, timeout: 30_000 })
  // And a combine against the accepted head is a real merge rather than exit 128.
  const merged = await git(room, ['merge-tree', '--write-tree', head, 'HEAD'])
  assert.match(merged.stdout.trim().split('\n')[0], /^[0-9a-f]{40}$/,
    'merge-tree writes a tree, which is what pushRevision needs to combine')
})

test('CONTROL: a genuinely new project still gets an unborn branch', async () => {
  // THE LINE THAT MUST NOT MOVE. Linking a new directory as a new project has no
  // project head to start from; fetching must answer nothing and change nothing.
  const root = mkdtempSync(join(tmpdir(), 'tlda-new-project-'))
  const remote = join(root, 'server.git')
  await git(root, ['init', '--bare', '-b', 'main', remote])
  const room = emptyRoom(root, 'brand-new')
  await git(root, ['init', '-b', 'main', room])
  await git(room, ['config', 'user.email', 'tlda@local'])
  await git(room, ['config', 'user.name', 'tlda source daemon'])

  const stood = await syncOver(room, 'brand-new', remote).standOnWorkBranch()
  assert.equal(stood.ok, true, `a new project still stands on its branch: ${JSON.stringify(stood)}`)
  const head = await git(room, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(r => r.stdout.trim(), () => '')
  assert.equal(head, '', 'no commits: the branch is unborn exactly as before')
})

test('CONTROL: a checkout that already has history keeps its own HEAD', async () => {
  // A person's checkout is not a fresh room. It must keep starting the branch
  // from their HEAD, not be moved onto the project head under them.
  const root = mkdtempSync(join(tmpdir(), 'tlda-person-checkout-'))
  const project = 'paper'
  const { remote, head } = await projectWithAcceptedHead(root, project)
  const mine = emptyRoom(root, 'mine')
  await git(root, ['init', '-b', 'main', mine])
  await git(mine, ['config', 'user.email', 'me@tlda'])
  await git(mine, ['config', 'user.name', 'me'])
  writeFileSync(join(mine, 'notes.md'), 'my own work\n')
  await git(mine, ['add', '-A'])
  await git(mine, ['commit', '-qm', 'mine'])
  const mineHead = (await git(mine, ['rev-parse', 'HEAD'])).stdout.trim()

  await syncOver(mine, project, remote).standOnWorkBranch()
  assert.equal((await git(mine, ['rev-parse', 'HEAD'])).stdout.trim(), mineHead,
    'their HEAD is untouched')
  assert.notEqual(mineHead, head, 'and it is not the project head')
})
