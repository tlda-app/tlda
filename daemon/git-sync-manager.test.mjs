import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createGitSyncManager } from './git-sync-manager.mjs'

function testWatcher() {
  const watcher = new EventEmitter()
  watcher.watch = (root, onChange) => {
    watcher.root = root
    watcher.change = onChange
    return watcher
  }
  watcher.close = async () => {}
  return watcher
}

const execFile = promisify(execFileCb)
const git = (cwd, args) => execFile('git', args, { cwd, encoding: 'utf8', timeout: 30000 })

test('bound working-copy event settles through the one Git proposal path', async () => {
  // `warnings` was used twice below and declared only in the NEXT test, so this
  // case threw ReferenceError before it could assert anything -- and it threw
  // while EVALUATING the assertion's own message argument, which is why the
  // failure named the assert line and looked like a real proposal failure.
  // It could never pass. `npx eslint` reports it as no-undef in about a second;
  // nothing runs eslint, which is the actual defect this line stands in for.
  const warnings = []
  const root = mkdtempSync(join(tmpdir(), 'tlda-git-sync-manager-'))
  const checkout = join(root, 'checkout')
  const remote = join(root, 'paper.git')
  await git(root, ['init', '--bare', remote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  writeFileSync(join(checkout, 'main.tex'), 'base\n')
  await git(checkout, ['add', '.'])
  await git(checkout, ['commit', '-m', 'base'])
  // The state `project link` leaves a checkout in: on its work branch.
  await git(checkout, ['checkout', '-b', 'tlda/paper'])
  const base = (await git(checkout, ['rev-parse', 'HEAD'])).stdout.trim()
  await git(checkout, ['push', remote, `${base}:refs/tlda/source/paper`])
  const watcher = testWatcher()
  const manager = createGitSyncManager({
    bindingsFile: join(root, 'bindings.json'), daemonId: 'daemon-a', server: 'http://unused.test',
    remoteUrlFor: () => remote, quietMs: 10, watch: watcher.watch,
    log: { info() {}, warn(value) { warnings.push(String(value)) }, error(value) { warnings.push(String(value)) } },
  })
  manager.bindSource('paper', checkout)
  await manager.sync([{ name: 'paper', mainFile: 'main.tex' }])
  writeFileSync(join(checkout, 'main.tex'), 'settled\n')
  watcher.change('change', 'main.tex')
  const deadline = Date.now() + 30000
  let refs = ''
  while (Date.now() < deadline) {
    refs = (await git(remote, ['for-each-ref', '--format=%(refname)', 'refs/tlda/proposals/daemon-a'])).stdout
    if (refs.trim()) break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.match(refs, /^refs\/tlda\/proposals\/daemon-a\/main\/[0-9a-f]{40}$/m, warnings.join('\n'))
  await manager.closeAll()
})

test('one broken binding does not prevent a later project binding from starting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-git-sync-isolation-'))
  const brokenCheckout = join(root, 'broken-checkout')
  const goodCheckout = join(root, 'good-checkout')
  const goodRemote = join(root, 'good.git')
  await git(root, ['init', '-b', 'main', brokenCheckout])
  await git(root, ['init', '--bare', goodRemote])
  await git(root, ['init', '-b', 'main', goodCheckout])
  await git(goodCheckout, ['config', 'user.name', 'fixture'])
  await git(goodCheckout, ['config', 'user.email', 'fixture@example.test'])
  writeFileSync(join(goodCheckout, 'main.tex'), 'good\n')
  await git(goodCheckout, ['add', '.'])
  await git(goodCheckout, ['commit', '-m', 'good'])
  // The state `project link` leaves a checkout in: on its work branch.
  await git(goodCheckout, ['checkout', '-b', 'tlda/good'])

  const warnings = []
  const manager = createGitSyncManager({
    bindingsFile: join(root, 'bindings.json'), daemonId: 'daemon-isolation', server: 'http://unused.test',
    remoteUrlFor: project => project === 'broken' ? join(root, 'missing', 'broken.git') : goodRemote,
    watch: () => testWatcher(),
    log: { info() {}, warn() {}, error() {} },
  })
  manager.bindSource('broken', brokenCheckout, { documentRoots: ['main.tex'] })
  manager.bindSource('good', goodCheckout, { documentRoots: ['main.tex'] })
  // This used to assert `sync` rejects with an AggregateError naming `broken:`.
  // 73adc3047 made a checkout with no commits legitimate — it starts at the
  // project head — so the empty checkout here is no longer a failure at all, and
  // demanding a rejection was asserting the state before that commit. The
  // guarantee in this test's name is unchanged and is what is checked now: the
  // binding that cannot submit reports why, and it does not stop the other one.
  await manager.sync([{ name: 'broken', mainFile: 'main.tex' }, { name: 'good', mainFile: 'main.tex' }])

  assert.equal((await manager.submit('broken')).status, 'empty-checkout')
  const submitted = await manager.submit('good')
  assert.equal(submitted.status, 'SubmittedToBuildQueue')
  await manager.closeAll()
})

test('existing tlda remote is reconciled without attempting to add it again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-git-remote-reconcile-'))
  const checkout = join(root, 'checkout')
  const oldRemote = join(root, 'old.git')
  const newRemote = join(root, 'new.git')
  await git(root, ['init', '--bare', oldRemote])
  await git(root, ['init', '--bare', newRemote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['remote', 'add', 'tlda', oldRemote])

  const manager = createGitSyncManager({
    bindingsFile: join(root, 'bindings.json'), daemonId: 'daemon-reconcile', server: 'http://unused.test',
    remoteUrlFor: () => newRemote, watch: () => testWatcher(),
    log: { info() {}, warn() {}, error() {} },
  })
  manager.bindSource('paper', checkout, { documentRoots: ['main.tex'] })
  await manager.sync([{ name: 'paper', mainFile: 'main.tex' }])
  assert.equal((await git(checkout, ['remote', 'get-url', 'tlda'])).stdout.trim(), newRemote)
  await manager.closeAll()
})

test('two projects submit to their owning project remotes', async () => {
  // ONE CHECKOUT EACH. This used to bind both projects to a single checkout,
  // which Skip disallowed on 2026-08-27 -- *"maybe let's just disallow that"* /
  // *"like, just clone right?"* -- because a checkout stands on ONE work branch,
  // so of N projects sharing it, N-1 silently never sync.
  //
  // The shared directory was never this test's subject: what it checks is that
  // each project submits to ITS OWN remote through `remoteUrlFor`. That is worth
  // keeping, so it keeps it, with the setup a person can now actually have.
  const root = mkdtempSync(join(tmpdir(), 'tlda-git-owning-remotes-'))
  const checkouts = { paper: join(root, 'paper-checkout'), response: join(root, 'response-checkout') }
  const remotes = {
    paper: join(root, 'paper.git'),
    response: join(root, 'response.git'),
  }
  await git(root, ['init', '--bare', remotes.paper])
  await git(root, ['init', '--bare', remotes.response])
  for (const checkout of Object.values(checkouts)) {
    await git(root, ['init', '-b', 'main', checkout])
    await git(checkout, ['config', 'user.name', 'fixture'])
    await git(checkout, ['config', 'user.email', 'fixture@example.test'])
    writeFileSync(join(checkout, 'main.tex'), 'shared source\n')
    await git(checkout, ['add', '.'])
    await git(checkout, ['commit', '-m', 'shared source'])
  }

  const manager = createGitSyncManager({
    bindingsFile: join(root, 'bindings.json'), daemonId: 'daemon-shared', server: 'http://unused.test',
    remoteUrlFor: project => remotes[project], watch: () => testWatcher(),
    log: { info() {}, warn() {}, error() {} },
  })
  manager.bindSource('paper', checkouts.paper, { documentRoots: ['main.tex'] })
  manager.bindSource('response', checkouts.response, { documentRoots: ['main.tex'] })
  await manager.sync([
    { name: 'paper', mainFile: 'main.tex' },
    { name: 'response', mainFile: 'main.tex' },
  ])

  const paper = await manager.submit('paper')
  const response = await manager.submit('response')
  assert.equal((await git(remotes.paper, ['rev-parse', paper.proposalRef])).stdout.trim(), paper.revision)
  assert.equal((await git(remotes.response, ['rev-parse', response.proposalRef])).stdout.trim(), response.revision)

  const tree = (await git(checkouts.paper, ['rev-parse', 'HEAD^{tree}'])).stdout.trim()
  // Each accepted head is built and pushed FROM the checkout that owns it, and
  // fetched back into that same one — which is the point now that the two are
  // separate trees rather than one directory wearing two hats.
  const paperHead = (await git(checkouts.paper, ['commit-tree', tree, '-m', 'paper accepted'])).stdout.trim()
  const responseTree = (await git(checkouts.response, ['rev-parse', 'HEAD^{tree}'])).stdout.trim()
  const responseHead = (await git(checkouts.response, ['commit-tree', responseTree, '-m', 'response accepted'])).stdout.trim()
  await git(checkouts.paper, ['push', remotes.paper, `${paperHead}:refs/tlda/source/paper`])
  await git(checkouts.response, ['push', remotes.response, `${responseHead}:refs/tlda/source/response`])
  await manager.headChanged('paper', paperHead)
  await manager.headChanged('response', responseHead)
  assert.equal((await git(checkouts.paper, ['rev-parse', 'refs/tlda/fetched/paper'])).stdout.trim(), paperHead)
  assert.equal((await git(checkouts.response, ['rev-parse', 'refs/tlda/fetched/response'])).stdout.trim(), responseHead)
  await manager.closeAll()
})

test('an up-to-date immutable proposal still requests confirmed admission', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-git-proposal-readmit-'))
  const checkout = join(root, 'checkout')
  const remote = join(root, 'paper.git')
  await git(root, ['init', '--bare', remote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  writeFileSync(join(checkout, 'main.tex'), 'paper\n')
  await git(checkout, ['add', '.'])
  await git(checkout, ['commit', '-m', 'paper'])
  // The state `project link` leaves a checkout in: on its work branch.
  await git(checkout, ['checkout', '-b', 'tlda/paper'])
  const admissions = []
  const manager = createGitSyncManager({
    bindingsFile: join(root, 'bindings.json'), daemonId: 'daemon-readmit', server: 'http://unused.test',
    remoteUrlFor: () => remote, watch: () => testWatcher(),
    onProposalSubmitted: async event => admissions.push(event),
    log: { info() {}, warn() {}, error() {} },
  })
  manager.bindSource('paper', checkout, { documentRoots: ['main.tex'] })
  await manager.sync([{ name: 'paper', mainFile: 'main.tex' }])
  const first = await manager.submit('paper')
  const second = await manager.submit('paper')
  assert.equal(first.revision, second.revision)
  // THREE, not two, and the extra one is first: `sync()` starts the binding and
  // `start()` now settles once, which submits because this fixture never pushes
  // to the shared ref, so there is outstanding work the moment the daemon comes
  // up. That is the behaviour 5408bf367 added deliberately -- a restart must not
  // eat an edit made while the daemon was down -- and this expectation was
  // written when startup submitted nothing.
  //
  // The property under test is unchanged and is now asserted more strongly than
  // before: every admission names the SAME proposal ref, because the content
  // never changes, so re-requesting admission for an up-to-date immutable
  // proposal is what all three are doing.
  assert.equal(admissions.length, 3)
  assert.deepEqual(
    admissions.map(item => item.proposalRef),
    [first.proposalRef, first.proposalRef, first.proposalRef],
  )
  await manager.closeAll()
})

test('explicit submit confirms admission even when the shared tree is already equal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-git-equal-tree-submit-'))
  const checkout = join(root, 'checkout')
  const remote = join(root, 'paper.git')
  await git(root, ['init', '--bare', remote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  writeFileSync(join(checkout, 'main.tex'), 'paper\n')
  await git(checkout, ['add', '.'])
  await git(checkout, ['commit', '-m', 'paper'])
  const head = (await git(checkout, ['rev-parse', 'HEAD'])).stdout.trim()
  await git(checkout, ['push', remote, `${head}:refs/tlda/source/paper`])
  await git(checkout, ['remote', 'add', 'tlda', remote])
  await git(checkout, ['fetch', 'tlda', '+refs/tlda/source/paper:refs/tlda/fetched/paper'])
  await git(checkout, ['update-ref', 'refs/tlda/applied/binding-a', head])
  const admissions = []
  const manager = createGitSyncManager({
    bindingsFile: join(root, 'bindings.json'), daemonId: 'mini-testing', server: 'http://unused.test',
    remoteUrlFor: () => remote, watch: () => testWatcher(),
    onProposalSubmitted: async event => admissions.push(event),
    log: { info() {}, warn() {}, error() {} },
  })
  manager.bindSource('paper', checkout, { bindingId: 'binding-a', documentRoots: ['main.tex'] })
  await manager.sync([{ name: 'paper', mainFile: 'main.tex' }])
  const submitted = await manager.submit('paper')
  assert.equal(submitted.status, 'SubmittedToBuildQueue')
  assert.equal(admissions.length, 1)
  assert.equal(admissions[0].revision, submitted.revision)
  await manager.closeAll()
})

// A daemon restart must not eat an edit made while it was down.
//
// This is the property, and it is worth stating as a sentence because the code
// that provides it does not look load-bearing: `start()` calls the settle path
// once. Delete that one call and everything still compiles, every other test
// still passes, and an edit typed during a restart is silently never submitted.
//
// Why nothing else catches it: the watcher is constructed `ignoreInitial: true`
// and `refreshWatchedMembers` re-adds members through `watcher.add(added)` with
// one argument, so chokidar's `initialAdd` is true and no `add` event fires
// (5.0.0, handler.js:395). `recover()` cannot help either -- it only re-pushes a
// revision already at `localRef`, and the missed edit never became one. The
// debouncer is pure memory. So before the fix the file reached the server only
// when the author happened to edit AGAIN, because the settle stages the whole
// tree and swept it in. Convergence by coincidence, not a property.
//
// The first worry on reading the fix is "does this settle on every boot?" -- it
// does not, and the second half of this test is that: a restart with nothing
// outstanding submits nothing, because settle() returns `equal-tree` without
// pushing when its tree matches the shared one.
test('a restart submits an edit made while the daemon was down, and submits nothing when there was none', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-git-restart-window-'))
  const checkout = join(root, 'checkout')
  const remote = join(root, 'paper.git')
  const bindingsFile = join(root, 'bindings.json')
  await git(root, ['init', '--bare', remote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  writeFileSync(join(checkout, 'main.tex'), 'before the restart\n')
  await git(checkout, ['add', '.'])
  await git(checkout, ['commit', '-m', 'base'])
  // The state `project link` leaves a checkout in: standing on its work branch.
  // settle only commits and pushes when it is, so a fixture on `main` is a
  // checkout that would not sync in real use either.
  await git(checkout, ['checkout', '-b', 'tlda/paper'])
  const base = (await git(checkout, ['rev-parse', 'HEAD'])).stdout.trim()
  await git(checkout, ['push', remote, `${base}:refs/tlda/source/paper`])

  const start = () => {
    const manager = createGitSyncManager({
      bindingsFile, daemonId: 'daemon-restart', server: 'http://unused.test',
      remoteUrlFor: () => remote, quietMs: 10, watch: () => testWatcher(),
      log: { info() {}, warn() {}, error() {} },
    })
    manager.bindSource('paper', checkout, { documentRoots: ['main.tex'] })
    return manager
  }
  const proposals = async () => (await git(remote, ['for-each-ref', '--format=%(refname)', 'refs/tlda/proposals']))
    .stdout.split('\n').filter(Boolean)

  const first = start()
  await first.sync([{ name: 'paper', mainFile: 'main.tex' }])
  await first.closeAll()
  const afterFirstStart = await proposals()

  // The daemon is down. Edit on disk, and emit NOTHING -- the fake watcher only
  // fires when told, which is exactly the real case: a process that is not
  // running observes no filesystem events.
  writeFileSync(join(checkout, 'main.tex'), 'typed while the daemon was down\n')
  await git(checkout, ['add', '.'])
  await git(checkout, ['commit', '-m', 'edit during the restart window'])

  const second = start()
  await second.sync([{ name: 'paper', mainFile: 'main.tex' }])
  const afterRestart = await proposals()
  assert.ok(
    afterRestart.length > afterFirstStart.length,
    `restart did not submit the edit made while the daemon was down (${afterFirstStart.length} proposal refs before, ${afterRestart.length} after)`,
  )
  const submitted = afterRestart.filter(ref => !afterFirstStart.includes(ref)).pop()
  const bytes = (await git(remote, ['show', `${submitted.split('/').pop()}:main.tex`])).stdout
  assert.match(bytes, /typed while the daemon was down/, 'the submitted revision does not carry the edit')
  await second.closeAll()

  // And now the half that keeps this from becoming a boot-time revision factory:
  // restart again with nothing changed, and nothing new may be submitted.
  const third = start()
  await third.sync([{ name: 'paper', mainFile: 'main.tex' }])
  const afterIdleRestart = await proposals()
  assert.deepEqual(
    afterIdleRestart.sort(), afterRestart.sort(),
    'a restart with nothing outstanding submitted a revision anyway',
  )
  await third.closeAll()
})
