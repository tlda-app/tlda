import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createGitProjectSync } from './git-project-sync.mjs'

const execFile = promisify(execFileCb)
async function git(cwd, args) { return execFile('git', args, { cwd, encoding: 'utf8', timeout: 30000 }) }

test('concurrent project pushes from one checkout use immutable owning remotes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-project-concurrent-remotes-'))
  const checkout = join(root, 'checkout')
  const paperRemote = join(root, 'paper.git')
  const responseRemote = join(root, 'response.git')
  await git(root, ['init', '--bare', paperRemote])
  await git(root, ['init', '--bare', responseRemote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  writeFileSync(join(checkout, 'main.tex'), 'shared\n')
  await git(checkout, ['add', '.'])
  await git(checkout, ['commit', '-m', 'shared'])
  const revision = (await git(checkout, ['rev-parse', 'HEAD'])).stdout.trim()
  const paper = createGitProjectSync({ sourceDir: checkout, project: 'paper', daemonId: 'daemon-a', bindingId: 'paper', remote: paperRemote })
  const response = createGitProjectSync({ sourceDir: checkout, project: 'response', daemonId: 'daemon-a', bindingId: 'response', remote: responseRemote })

  const [paperPush, responsePush] = await Promise.all([
    paper.pushRevision(revision),
    response.pushRevision(revision),
  ])
  assert.equal((await git(paperRemote, ['rev-parse', paperPush.proposalRef])).stdout.trim(), revision)
  assert.equal((await git(responseRemote, ['rev-parse', responsePush.proposalRef])).stdout.trim(), revision)
})

test('settle submits an immutable daemon proposal and HeadChanged fetches exact head', async t => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-project-git-sync-'))
  const remote = join(root, 'server.git')
  const checkout = join(root, 'checkout')
  await git(root, ['init', '--bare', remote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  await git(checkout, ['remote', 'add', 'tlda', remote])
  writeFileSync(join(checkout, 'main.tex'), '\\input{chapter}\n')
  writeFileSync(join(checkout, 'chapter.tex'), 'one\n')
  writeFileSync(join(checkout, 'notes.txt'), 'not project source\n')
  await git(checkout, ['add', 'main.tex', 'chapter.tex', 'notes.txt'])
  await git(checkout, ['commit', '-m', 'base'])
  const base = (await git(checkout, ['rev-parse', 'HEAD'])).stdout.trim()
  await git(checkout, ['push', 'tlda', `${base}:refs/tlda/source/paper`])
  await git(checkout, ['update-ref', 'refs/tlda/applied/binding-a', base])
  await git(checkout, ['fetch', 'tlda', '+refs/tlda/source/paper:refs/tlda/fetched/paper'])
  const baseTree = (await git(checkout, ['rev-parse', `${base}^{tree}`])).stdout.trim()
  const remoteSibling = (await git(checkout, ['commit-tree', baseTree, '-p', base, '-m', 'external remote head'])).stdout.trim()
  await git(checkout, ['update-ref', 'refs/tlda/remote/observed', remoteSibling])

  const submitted = []
  const arrived = []
  const sync = createGitProjectSync({ sourceDir: checkout, project: 'paper', daemonId: 'daemon-a', bindingId: 'binding-a', onSubmitted: value => submitted.push(value), onMirrorArrived: value => arrived.push(value) })
  writeFileSync(join(checkout, 'chapter.tex'), 'two\n')
  const proposal = await sync.editClusterSettled()
  assert.equal(proposal.status, 'SubmittedToBuildQueue')
  assert.equal(submitted.length, 1)
  assert.match(proposal.proposalRef, new RegExp(`^refs/tlda/proposals/daemon-a/main/${proposal.revision}$`))
  assert.equal((await git(remote, ['rev-parse', proposal.proposalRef])).stdout.trim(), proposal.revision)
  await git(checkout, ['merge-base', '--is-ancestor', remoteSibling, proposal.revision])
  assert.deepEqual((await git(remote, ['ls-tree', '-r', '--name-only', proposal.revision])).stdout.trim().split('\n'), ['chapter.tex', 'main.tex'])
  await assert.rejects(git(remote, ['cat-file', '-e', `${proposal.revision}:notes.txt`]))
  assert.equal((await git(remote, ['rev-parse', 'refs/tlda/source/paper'])).stdout.trim(), base, 'submission does not advance shared head')

  await git(remote, ['update-ref', 'refs/tlda/source/paper', proposal.revision, base])
  const mirrored = await sync.headChanged(proposal.revision)
  assert.equal(arrived.at(-1).revision, proposal.revision)
  // The accepted head is parked, not applied. It is reachable at the fetched ref
  // and the applied ref stays where it was, because nothing advances it now.
  assert.equal(mirrored.status, 'observed')
  assert.equal((await git(checkout, ['rev-parse', 'refs/tlda/fetched/paper'])).stdout.trim(), proposal.revision)
  assert.equal((await git(checkout, ['rev-parse', 'refs/tlda/applied/binding-a'])).stdout.trim(), base)
})

test('configured document roots exclude unrelated broken TeX files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-project-root-filter-'))
  const remote = join(root, 'server.git')
  const checkout = join(root, 'checkout')
  await git(root, ['init', '--bare', remote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  await git(checkout, ['remote', 'add', 'tlda', remote])
  writeFileSync(join(checkout, 'main.tex'), '\\input{chapter}\n')
  writeFileSync(join(checkout, 'chapter.tex'), 'included\n')
  writeFileSync(join(checkout, 'backup.tex'), '\\input{missing}\n')
  await git(checkout, ['add', '.'])
  await git(checkout, ['commit', '-m', 'base'])

  const sync = createGitProjectSync({
    sourceDir: checkout,
    project: 'paper',
    daemonId: 'daemon-a',
    bindingId: 'binding-a',
    documentRoots: ['main.tex'],
  })
  const proposal = await sync.editClusterSettled()
  assert.equal(proposal.status, 'SubmittedToBuildQueue')
  assert.deepEqual((await git(remote, ['ls-tree', '-r', '--name-only', proposal.revision])).stdout.trim().split('\n'), ['chapter.tex', 'main.tex'])
})

test('explicit same-revision rebuild reaches proposal admission metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-project-force-rebuild-'))
  const remote = join(root, 'server.git')
  const checkout = join(root, 'checkout')
  await git(root, ['init', '--bare', remote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  await git(checkout, ['remote', 'add', 'tlda', remote])
  writeFileSync(join(checkout, 'main.tex'), 'paper\n')
  await git(checkout, ['add', '.'])
  await git(checkout, ['commit', '-m', 'paper'])
  const submitted = []
  const sync = createGitProjectSync({
    sourceDir: checkout,
    project: 'paper',
    daemonId: 'daemon-a',
    bindingId: 'binding-a',
    documentRoots: ['main.tex'],
    onSubmitted: value => submitted.push(value),
  })

  const first = await sync.submitCurrent()
  const rebuilt = await sync.submitCurrent({ forceRebuild: true })
  assert.equal(rebuilt.revision, first.revision)
  assert.equal(submitted[0].forceRebuild, false)
  assert.equal(submitted[1].forceRebuild, true)
})

test('missing canonical source ref is pre-first-acceptance, while other fetch failures remain errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-project-missing-shared-'))
  const remote = join(root, 'server.git')
  const checkout = join(root, 'checkout')
  await git(root, ['init', '--bare', remote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  await git(checkout, ['remote', 'add', 'tlda', remote])
  writeFileSync(join(checkout, 'main.tex'), 'paper\n')
  await git(checkout, ['add', '.'])
  await git(checkout, ['commit', '-m', 'paper'])

  const sync = createGitProjectSync({ sourceDir: checkout, project: 'paper', daemonId: 'mini-testing', bindingId: 'binding-a' })
  assert.deepEqual(await sync.headChanged(), { ok: true, status: 'no-shared-head', revision: null })

  const denied = Object.assign(new Error('authentication failed'), { stderr: 'fatal: Authentication failed' })
  const broken = createGitProjectSync({
    sourceDir: checkout,
    project: 'paper',
    daemonId: 'mini-testing',
    bindingId: 'binding-a',
    runGit: async () => { throw denied },
  })
  await assert.rejects(broken.headChanged(), /authentication failed/)
})

// bin/settle-does-not-echo-a-proposal-test.mjs covers `equal-tree` too, from the
// tester's side. Both are deliberate and neither is duplication: that one is the
// independent-authorship proof and additionally asserts the REMOTE, so a push
// that pushed and forgot to fire onSubmitted would not satisfy it. This one runs
// inside `node --test` with the rest of the suite, which is where a future
// regression actually gets caught — a standalone harness in bin/ only runs when
// someone remembers it. Neither is red on main: the equal-tree line is
// byte-identical on both branches and only its line number moved, so these are
// coverage for live code that had none, not violations.
//
// Under parking, this comparison is the ONLY thing standing between a settle and
// a proposal duplicating what the server already accepted. It used to be covered
// by 'accepted mirror with no local difference produces no proposal echo', whose
// premise was that headChanged returned 'merged' — so the merge made the trees
// equal by construction and the branch was reached for free. Nothing makes them
// equal now, which is exactly why the branch matters more and needs its own test.
test('a settle whose tree already equals the shared head submits no proposal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-project-equal-tree-'))
  const checkout = join(root, 'checkout')
  const remote = join(root, 'remote')
  for (const dir of [checkout, remote]) {
    await git(root, ['init', '-b', 'main', dir])
    await git(dir, ['config', 'user.name', 'fixture'])
    await git(dir, ['config', 'user.email', 'fixture@example.test'])
    // Identical bytes, independent histories: the person's tree already says what
    // the server accepted, without either side descending from the other.
    writeFileSync(join(dir, 'main.tex'), 'same bytes\n')
    await git(dir, ['add', 'main.tex'])
    await git(dir, ['commit', '-m', 'paper'])
  }
  const revision = (await git(remote, ['rev-parse', 'HEAD'])).stdout.trim()
  await git(remote, ['update-ref', 'refs/tlda/source/paper', revision])

  const submitted = []
  const sync = createGitProjectSync({
    sourceDir: checkout, project: 'paper', daemonId: 'daemon-a', bindingId: 'binding-a',
    branch: 'main', remote, documentRoots: ['main.tex'],
    log: { info: () => {}, warn: () => {}, error: () => {} },
    onSubmitted: event => submitted.push(event),
  })

  assert.deepEqual(await sync.headChanged(revision), { ok: true, status: 'observed', revision })

  const settled = await sync.editClusterSettled()

  assert.equal(settled.status, 'equal-tree', 'the trees are equal, so there is nothing to propose')
  assert.equal(submitted.length, 0, 'no proposal may duplicate what the server already accepted')
  assert.equal(
    (await git(remote, ['for-each-ref', '--format=%(refname)', 'refs/tlda/proposals'])).stdout.trim(), '',
    'and none reached the remote',
  )
})

// The other branch of the missing-dependency skip. A reference to a file that
// does not exist anywhere is a defect in the document, not an unstaged file —
// and the two are logged differently for that reason. Both must skip: neither
// may stop the project submitting. The revision that results will not build,
// which is correct and is not asserted against here.
test('a reference to a file that does not exist skips without stopping the settle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-project-broken-ref-'))
  const checkout = join(root, 'checkout')
  const remote = join(root, 'remote.git')
  await git(root, ['init', '--bare', remote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  writeFileSync(join(checkout, 'main.tex'), 'chapter one\n')
  writeFileSync(join(checkout, 'chapter2.tex'), 'chapter two\n')
  await git(checkout, ['add', 'main.tex', 'chapter2.tex'])
  await git(checkout, ['commit', '-m', 'the author writes their paper'])
  // Tracked, committed, and now pointing at BOTH a real chapter and a file that
  // is nowhere: not on disk, not in the index, not in HEAD. chapter2 has to be
  // \input too, or it is not in the closure and its presence in the revision
  // would prove nothing.
  writeFileSync(join(checkout, 'main.tex'), 'chapter one\n\\input{chapter2}\n\\input{nowhere}\n')

  const submitted = []
  const sync = createGitProjectSync({
    sourceDir: checkout, project: 'paper', daemonId: 'daemon-a', bindingId: 'binding-a',
    branch: 'main', remote, documentRoots: ['main.tex'],
    log: { info: () => {}, warn: () => {}, error: () => {} },
    onSubmitted: event => submitted.push(event),
  })

  const settled = await sync.editClusterSettled()

  // The positive half is the contract. "nowhere.tex is absent" is also what a
  // completely broken repair produces; "chapter2.tex still reached the server"
  // is not.
  assert.equal(settled.status, 'SubmittedToBuildQueue', 'a broken reference must not stop the settle')
  assert.equal(submitted.length, 1)
  assert.deepEqual(
    (await git(remote, ['ls-tree', '-r', '--name-only', settled.revision])).stdout.trim().split('\n').sort(),
    ['chapter2.tex', 'main.tex'],
    'every other file in the build still reached the server',
  )
})
