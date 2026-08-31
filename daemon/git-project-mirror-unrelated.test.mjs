import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createGitProjectSync } from './git-project-sync.mjs'

const execFile = promisify(execFileCb)
const git = (cwd, args) => execFile('git', args, { cwd, encoding: 'utf8', timeout: 30000 })

async function fixture({ local = null, accepted = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tlda-unrelated-mirror-'))
  const remote = join(root, 'server.git')
  const publisher = join(root, 'publisher')
  const checkout = join(root, 'author')
  await git(root, ['init', '--bare', remote])
  for (const repo of [publisher, checkout]) {
    await git(root, ['init', '-b', 'main', repo])
    await git(repo, ['config', 'user.name', 'fixture'])
    await git(repo, ['config', 'user.email', 'fixture@example.test'])
    writeFileSync(join(repo, 'main.tex'), 'base\n')
    await git(repo, ['add', 'main.tex'])
    await git(repo, ['commit', '-m', 'independent base'])
  }
  const applied = (await git(publisher, ['rev-parse', 'HEAD'])).stdout.trim()
  if (accepted) {
    for (const [file, content] of Object.entries(accepted)) writeFileSync(join(publisher, file), content)
    await git(publisher, ['add', '-A'])
    await git(publisher, ['commit', '-m', 'accepted change'])
  }
  const revision = (await git(publisher, ['rev-parse', 'HEAD'])).stdout.trim()
  await git(publisher, ['push', remote, `${revision}:refs/tlda/source/paper`])
  await git(checkout, ['remote', 'add', 'tlda', remote])
  await git(checkout, ['fetch', 'tlda', '+refs/tlda/source/paper:refs/tlda/fetched/paper'])
  await git(checkout, ['update-ref', 'refs/tlda/applied/binding-a', applied])
  if (local) {
    for (const [file, content] of Object.entries(local)) writeFileSync(join(checkout, file), content)
    await git(checkout, ['add', '-A'])
    await git(checkout, ['commit', '-m', 'local author change'])
  }
  await git(checkout, ['update-ref', 'refs/tlda/project/paper', (await git(checkout, ['rev-parse', 'HEAD'])).stdout.trim()])
  // The state `project link` leaves a checkout in: standing on its work branch.
  // settle only commits and pushes when it is, so a fixture on `main` is a
  // checkout that would not sync in real use either. Same correction 84c48f6e4
  // made to the other two fixture files; this one was missed.
  await git(checkout, ['checkout', '-q', '-b', 'tlda/paper'])
  const submitted = []
  const calls = []
  const sync = createGitProjectSync({
    sourceDir: checkout, project: 'paper', daemonId: 'daemon-a', bindingId: 'binding-a',
    onSubmitted: event => submitted.push(event),
    runGit: (args, options = {}) => {
      calls.push(args)
      return execFile('git', args, { cwd: options.cwd || checkout, encoding: 'utf8', timeout: 30000, ...options })
    },
  })
  return { root, remote, checkout, applied, revision, sync, submitted, calls }
}

// Everything the app must not disturb, in one value: where their branch points,
// the exact bytes of their index, the bytes of every tracked file, and whether a
// merge of their own is in progress. Comparing two of these is the territory
// assertion — a diff anywhere in it is the app having written their repository.
async function checkoutSnapshot(checkout) {
  const gitPath = value => value.startsWith('/') ? value : join(checkout, value)
  const indexPath = gitPath((await git(checkout, ['rev-parse', '--git-path', 'index'])).stdout.trim())
  const mergeHeadPath = gitPath((await git(checkout, ['rev-parse', '--git-path', 'MERGE_HEAD'])).stdout.trim())
  const tracked = (await git(checkout, ['ls-files', '-z'])).stdout.split('\0').filter(Boolean)
  return {
    head: (await git(checkout, ['rev-parse', 'HEAD'])).stdout.trim(),
    branch: (await git(checkout, ['symbolic-ref', 'HEAD'])).stdout.trim(),
    index: readFileSync(indexPath),
    files: Object.fromEntries([...new Set(tracked)].map(file => [file, readFileSync(join(checkout, file))])),
    mergeHead: existsSync(mergeHeadPath) ? readFileSync(mergeHeadPath) : null,
  }
}

test('accepted history unrelated to the checkout is parked, never adopted or merged', async () => {
  const f = await fixture({ local: { 'local.tex': 'local\n' }, accepted: { 'accepted.tex': 'accepted\n' } })
  const before = await checkoutSnapshot(f.checkout)
  const callStart = f.calls.length

  const result = await f.sync.headChanged(f.revision)

  assert.deepEqual(result, { ok: true, status: 'observed', revision: f.revision })
  assert.deepEqual(await checkoutSnapshot(f.checkout), before)
  assert.equal(existsSync(join(f.checkout, 'accepted.tex')), false, 'the server file must not appear in the checkout')
  // The accepted revision is reachable, which is the whole obligation.
  assert.equal((await git(f.checkout, ['rev-parse', 'refs/tlda/fetched/paper'])).stdout.trim(), f.revision)
  // Nothing advanced the applied ref, because nothing applied anything.
  assert.equal((await git(f.checkout, ['rev-parse', 'refs/tlda/applied/binding-a'])).stdout.trim(), f.applied)
  const used = f.calls.slice(callStart).map(args => args[0])
  for (const forbidden of ['merge', 'checkout', 'commit', 'add', 'update-index', 'read-tree', 'reset']) {
    assert.equal(used.includes(forbidden), false, `git ${forbidden} must not run on the person's checkout`)
  }
  assert.equal(f.calls.slice(callStart).some(args => args[0] === 'update-ref' && !/^refs\/tlda\//.test(args[1])), false)
})

test('a would-be conflict is parked instead of being left unresolved in the checkout', async () => {
  const f = await fixture({ local: { 'main.tex': 'ours\n' }, accepted: { 'main.tex': 'theirs\n' } })
  const before = await checkoutSnapshot(f.checkout)

  const result = await f.sync.headChanged(f.revision)

  assert.deepEqual(result, { ok: true, status: 'observed', revision: f.revision })
  assert.deepEqual(await checkoutSnapshot(f.checkout), before)
  assert.equal(readFileSync(join(f.checkout, 'main.tex'), 'utf8'), 'ours\n', 'their file keeps their bytes')
  assert.equal(existsSync(join(f.checkout, '.git', 'MERGE_HEAD')), false)
  assert.equal((await git(f.checkout, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim(), '')
})

// recover() runs on every project start — the daemon was down, sort it out. Its
// job under parking is to submit local work that never reached the server. It
// submits a PROPOSAL, so a diverged local is offered rather than imposed: the
// shared head is the server's to move, and it does not move here.
test('recover submits local work the server never saw, without moving the shared head', async () => {
  const f = await fixture({ local: { 'local.tex': 'local\n' }, accepted: { 'accepted.tex': 'accepted\n' } })
  await f.sync.headChanged(f.revision)

  const result = await f.sync.recover()

  assert.equal(result.status, 'SubmittedToBuildQueue')
  assert.equal(f.submitted.length, 1)
  assert.match(
    (await git(f.remote, ['for-each-ref', '--format=%(refname)', 'refs/tlda/proposals'])).stdout.trim(),
    /^refs\/tlda\/proposals\//,
  )
  assert.equal((await git(f.remote, ['rev-parse', 'refs/tlda/source/paper'])).stdout.trim(), f.revision, 'the shared head is the server\'s to move')
})

// This asserted the opposite until 84c48f6e4: that their branch stayed put and
// their tree stayed dirty. That was the defect, not the contract — a checkout
// permanently dirty against its own HEAD is one where `git checkout` and
// `tlda project remote pull` refuse forever. settle now commits the edit under
// them on the branch they are standing on, which is what makes the tree clean.
test('a tracked edit is submitted and committed under them, leaving their checkout clean', async () => {
  const f = await fixture()
  const before = await checkoutSnapshot(f.checkout)
  writeFileSync(join(f.checkout, 'main.tex'), 'tracked edit\n')

  const result = await f.sync.editClusterSettled()

  assert.equal(result.status, 'SubmittedToBuildQueue')
  assert.equal((await git(f.remote, ['show', `${result.revision}:main.tex`])).stdout, 'tracked edit\n')
  const after = await checkoutSnapshot(f.checkout)
  // They are still standing where they were — settle moves the branch under
  // them, it does not move them to another branch.
  assert.equal(after.branch, before.branch)
  assert.notEqual(after.head, before.head, 'the work branch advances to carry their edit')
  assert.equal((await git(f.checkout, ['show', 'HEAD:main.tex'])).stdout, 'tracked edit\n')
  assert.equal((await git(f.checkout, ['status', '--porcelain'])).stdout.trim(), '', 'their checkout is clean afterwards')
  assert.equal((await git(f.checkout, ['rev-parse', 'refs/tlda/project/paper'])).stdout.trim(), result.revision)
})

test('an untracked file is not swept into the submitted revision or their index', async () => {
  const f = await fixture()
  const before = await checkoutSnapshot(f.checkout)
  writeFileSync(join(f.checkout, 'main.tex'), 'tracked edit\n')
  writeFileSync(join(f.checkout, 'scratch.txt'), 'mine, not the project\n')

  const result = await f.sync.editClusterSettled()

  assert.equal(result.status, 'SubmittedToBuildQueue')
  assert.equal((await git(f.remote, ['show', `${result.revision}:main.tex`])).stdout, 'tracked edit\n')
  await assert.rejects(git(f.remote, ['cat-file', '-e', `${result.revision}:scratch.txt`]), 'the untracked file must not be submitted')
  assert.equal((await git(f.checkout, ['ls-files', '--', 'scratch.txt'])).stdout.trim(), '', 'the untracked file must not be staged')
  // The index is no longer byte-identical — settle commits under them and then
  // `reset --mixed` brings their index to that commit. What must still hold is
  // that the untracked file was not swept in on the way: it is the ONLY thing
  // `git status` has left to say, which is a stronger statement than comparing
  // index bytes, because it also catches the file being staged and committed.
  assert.equal((await git(f.checkout, ['status', '--porcelain'])).stdout.trim(), '?? scratch.txt')
  assert.equal(readFileSync(join(f.checkout, 'scratch.txt'), 'utf8'), 'mine, not the project\n')
})

test('a path the person already staged is carried, as commit -a would carry it', async () => {
  const f = await fixture()
  writeFileSync(join(f.checkout, 'main.tex'), 'staged by them\n')
  await git(f.checkout, ['add', 'main.tex'])
  const before = await checkoutSnapshot(f.checkout)

  const result = await f.sync.editClusterSettled()

  assert.equal(result.status, 'SubmittedToBuildQueue')
  assert.equal((await git(f.remote, ['show', `${result.revision}:main.tex`])).stdout, 'staged by them\n')
  const after = await checkoutSnapshot(f.checkout)
  assert.equal(after.branch, before.branch)
  // settledCommit stages into a COPY of their index, so what they had staged is
  // never disturbed mid-settle; the commit it produces captures it, and
  // `reset --mixed` then brings their real index to that commit. So their staged
  // work is not lost and not left half-applied — it is committed under them.
  assert.equal((await git(f.checkout, ['show', 'HEAD:main.tex'])).stdout, 'staged by them\n')
  assert.equal((await git(f.checkout, ['status', '--porcelain'])).stdout.trim(), '')
})

test('settle refuses and preserves a merge the person started themselves', async () => {
  const f = await fixture()
  await git(f.checkout, ['checkout', '-q', '-b', 'user-merge'])
  writeFileSync(join(f.checkout, 'merged.tex'), 'user branch\n')
  await git(f.checkout, ['add', 'merged.tex'])
  await git(f.checkout, ['commit', '-m', 'user branch'])
  // Back onto the work branch, so the merge is in progress where settle would
  // otherwise commit. Merging on `main` would be refused as not-on-work-branch,
  // which is a different refusal and would not exercise this one at all.
  await git(f.checkout, ['checkout', '-q', 'tlda/paper'])
  writeFileSync(join(f.checkout, 'main.tex'), 'main side\n')
  await git(f.checkout, ['commit', '-a', '-m', 'main side'])
  await git(f.checkout, ['merge', '--no-commit', '--no-ff', 'user-merge'])
  const before = await checkoutSnapshot(f.checkout)
  assert.notEqual(before.mergeHead, null)
  const callStart = f.calls.length

  assert.deepEqual(await f.sync.editClusterSettled(), { ok: false, status: 'merge-in-progress' })

  assert.deepEqual(await checkoutSnapshot(f.checkout), before)
  assert.equal(f.calls.slice(callStart).some(args => args[0] === 'commit'), false)
})
