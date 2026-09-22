/**
 * **One checkout carries one project.**
 *
 * Skip, 2026-08-27: *"maybe let's just disallow that"* / *"like, just clone
 * right?"*
 *
 * **What sharing one costs, measured before he ruled.** A checkout stands on
 * exactly ONE work branch, and a project syncs only while its own branch is
 * checked out — *"if you have a daemon-managed branch checked out, it commits,
 * and pushes, and all that shit. otherwise it doesn't."* So of N projects bound
 * to one directory, N-1 never sync.
 *
 * **And the person is told nothing.** The edit commits, the working tree is
 * clean, no command errors, and the only trace is `proposal not accepted:
 * not-on-work-branch` in a daemon log on the machine. On this box that day: **10
 * checkouts carried 27 projects, so at least 17 could not sync.** It is why a
 * real two-person editing session did not work.
 *
 * `bindSource` already refused the mirror image — one project bound to two
 * checkouts. This is the converse, in the same place, because bind is the one
 * point every route reaches: the CLI, the source room, and the server-side room
 * manager all arrive here.
 *
 * The second test is the one that matters: it demonstrates the SILENT FAILURE
 * the rejection exists to prevent, so nobody later reads the guard as fussiness.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { createGitSyncManager } from './git-sync-manager.mjs'
import { createGitProjectSync } from './git-project-sync.mjs'

const execFile = promisify(execFileCb)
const git = (cwd, args) => execFile('git', args, { cwd, encoding: 'utf8', timeout: 30_000 })

const managerOver = (root, options = {}) => createGitSyncManager({
  bindingsFile: join(root, 'bindings.json'),
  daemonId: 'daemon-a',
  server: 'http://unused.test',
  log: { info() {}, warn() {}, error() {} },
  ...options,
})

test('a second project cannot be linked to a checkout that already has one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-one-checkout-'))
  const checkout = join(root, 'shared')
  await git(root, ['init', '-b', 'main', checkout])
  const manager = managerOver(root)

  manager.bindSource('first-project', checkout)

  assert.throws(
    () => manager.bindSource('second-project', checkout),
    error => {
      assert.match(error.message, /already the checkout for project first-project/,
        `it names the project already holding the directory: ${error.message}`)
      assert.match(error.message, /clone/,
        `and says what to do instead, which is what he asked for: ${error.message}`)
      return true
    },
    'binding a second project to one checkout must be refused',
  )

  // AND THE REFUSAL LEFT NOTHING BEHIND. A half-written binding would be worse
  // than the state it refused.
  assert.deepEqual(Object.keys(JSON.parse(await import('node:fs').then(fs => fs.promises.readFile(join(root, 'bindings.json'), 'utf8')))),
    ['first-project'], 'the rejected project was not recorded')
})

test('re-binding the SAME project to its own checkout still works', async () => {
  // The line the guard must not cross. `project link` is run again on a project
  // that is already linked — that is the ordinary relink path and it must stay
  // ordinary, or the repair for rootless projects stops working.
  const root = mkdtempSync(join(tmpdir(), 'tlda-rebind-'))
  const checkout = join(root, 'mine')
  await git(root, ['init', '-b', 'main', checkout])
  const manager = managerOver(root)

  manager.bindSource('paper', checkout, { mainFile: 'main.tex' })
  const again = manager.bindSource('paper', checkout, { mainFile: 'main.tex' })
  assert.equal(again.project, 'paper')
  assert.equal(again.linked, false, 'a re-bind is not a new link')
})

test('an explicit projection shares its owners checkout without becoming another owner', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-projection-binding-'))
  const checkout = join(root, 'shared')
  await git(root, ['init', '-b', 'main', checkout])
  const manager = managerOver(root)

  manager.bindSource('book', checkout, { documentRoots: ['book.qmd'] })
  const projection = manager.bindSource('probability-deck', checkout, {
    sourceOwner: 'book',
    documentRoots: ['decks/probability.qmd'],
  })

  assert.equal(projection.sourceOwner, 'book')
  assert.deepEqual(projection.documentRoots, ['decks/probability.qmd'])
  assert.deepEqual(manager.bindingRecords().map(item => [item.project, item.sourceOwner || null]), [
    ['book', null],
    ['probability-deck', 'book'],
  ])
})

test('a projection does not become a second editor-attribution authority', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-projection-attribution-'))
  const checkout = join(root, 'shared')
  await git(root, ['init', '-b', 'main', checkout])
  const manager = managerOver(root)
  manager.bindSource('book', checkout, { documentRoots: ['book.qmd'] })
  manager.bindSource('deck', checkout, { sourceOwner: 'book', documentRoots: ['decks/probability.qmd'] })

  assert.deepEqual(manager.sourceFileForAbsolutePath(join(checkout, 'decks', 'probability.qmd')), {
    project: 'book', file: 'decks/probability.qmd',
  })
})

test('an owner cannot be unbound while its projection depends on it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-projection-unbind-'))
  const checkout = join(root, 'shared')
  await git(root, ['init', '-b', 'main', checkout])
  const manager = managerOver(root)
  manager.bindSource('book', checkout, { documentRoots: ['book.qmd'] })
  manager.bindSource('deck', checkout, { sourceOwner: 'book', documentRoots: ['deck.qmd'] })

  assert.throws(() => manager.unbindSource('book'), /still owns projection deck/)
  assert.deepEqual(manager.boundProjectNames(), ['book', 'deck'], 'the refusal leaves both bindings intact')
})

test('projection submission carries its caller server and one-shot token only to the projection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-projection-credential-'))
  const checkout = join(root, 'shared')
  await git(root, ['init', '-b', 'main', checkout])
  const pushes = []
  const createProjectSync = options => ({
    members: async () => [],
    recover: async () => ({ ok: true }),
    editClusterSettled: async () => ({ ok: true, status: 'equal-tree', revision: null }),
    submitCurrent: async received => ({ ok: true, revision: 'a'.repeat(40), received }),
    pushRevision: async (revision, received) => {
      pushes.push({ project: options.project, revision, received })
      return { ok: true, revision }
    },
    fetchHead: async () => null,
    projectRevision: async revision => ({ commit: revision }),
    standOnWorkBranch: async () => ({ ok: true }),
    setDocumentRoots() {},
  })
  const watcher = { on() {}, close() {} }
  const manager = managerOver(root, { createProjectSync, watch: () => watcher })
  manager.bindSource('book', checkout, { documentRoots: ['book.qmd'] })
  manager.bindSource('deck', checkout, { sourceOwner: 'book', documentRoots: ['deck.qmd'] })

  await manager.submit('deck', { serverOverride: 'https://preview.example.test', tokenOverride: 'one-shot' })
  await manager.closeAll()

  assert.equal(pushes.length, 1)
  assert.equal(pushes[0].project, 'deck')
  const target = new URL(pushes[0].received.pushTarget)
  assert.equal(target.origin, 'https://preview.example.test')
  assert.equal(target.username, 'daemon-a')
  assert.equal(target.password, 'one-shot')
})

test('a projection history seed does not replace the owner transport remote', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-projection-seed-'))
  const checkout = join(root, 'shared')
  const ownerRemote = join(root, 'book.git')
  const projectionRemote = join(root, 'deck.git')
  await git(root, ['init', '--bare', ownerRemote])
  await git(root, ['init', '--bare', projectionRemote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  writeFileSync(join(checkout, 'book.qmd'), '# Book\n')
  await git(checkout, ['add', '-A'])
  await git(checkout, ['commit', '-m', 'base'])
  await git(checkout, ['remote', 'add', 'tlda', ownerRemote])
  const revision = (await git(checkout, ['rev-parse', 'HEAD'])).stdout.trim()
  const manager = managerOver(root, { remoteUrlFor: project => project === 'deck' ? projectionRemote : ownerRemote })

  await manager.pushHistorySeed('deck', checkout, revision, null, undefined, true)

  assert.equal((await git(checkout, ['remote', 'get-url', 'tlda'])).stdout.trim(), ownerRemote)
  const seed = `refs/tlda/history-seeds/daemon-a/${revision}`
  assert.equal((await git(projectionRemote, ['rev-parse', seed])).stdout.trim(), revision)
})

test('projection head-change and welcome polling cannot start a second runtime or watcher', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-projection-runtime-'))
  const checkout = join(root, 'shared')
  const remote = join(root, 'book.git')
  await git(root, ['init', '--bare', remote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  writeFileSync(join(checkout, 'book.qmd'), '# Book\n')
  writeFileSync(join(checkout, 'deck.qmd'), '# Deck\n')
  await git(checkout, ['add', '-A'])
  await git(checkout, ['commit', '-m', 'base'])
  let watchers = 0
  const manager = managerOver(root, {
    remoteUrlFor: () => remote,
    watch: () => { watchers += 1; return { on() {}, close() {} } },
  })
  manager.bindSource('book', checkout, { documentRoots: ['book.qmd'] })
  manager.bindSource('deck', checkout, { sourceOwner: 'book', documentRoots: ['deck.qmd'] })

  await manager.sync([{ name: 'book', mainFile: 'book.qmd' }, { name: 'deck', mainFile: 'deck.qmd' }])
  assert.deepEqual(await manager.headChanged('deck', 'a'.repeat(40)), {
    skipped: true, reason: 'projection-owned', sourceOwner: 'book',
  })
  assert.deepEqual(await manager.pollRemote('deck'), {
    skipped: true, reason: 'projection-owned', sourceOwner: 'book',
  })
  assert.equal(watchers, 1, 'welcome/head-change paths leave the owner as the only watcher')
  await assert.rejects(() => manager.standOnWorkBranch('deck'), /has no work branch/)
  await manager.closeAll()
})

test('a projection requires its declared owner in the same checkout', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-projection-owner-'))
  const first = join(root, 'first')
  const second = join(root, 'second')
  await git(root, ['init', '-b', 'main', first])
  await git(root, ['init', '-b', 'main', second])
  const manager = managerOver(root)
  manager.bindSource('book', first, { documentRoots: ['book.qmd'] })

  assert.throws(() => manager.bindSource('deck', second, {
    sourceOwner: 'book', documentRoots: ['deck.qmd'],
  }), /bound to another checkout/)
})

test('a projection revision descends from its accepted filtered head', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-projection-revision-'))
  const checkout = join(root, 'shared')
  const remotes = {
    book: join(root, 'book.git'),
    deck: join(root, 'deck.git'),
  }
  await git(root, ['init', '--bare', remotes.book])
  await git(root, ['init', '--bare', remotes.deck])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  writeFileSync(join(checkout, 'book.qmd'), '# Book\n')
  await import('node:fs').then(fs => fs.promises.mkdir(join(checkout, 'decks')))
  writeFileSync(join(checkout, 'decks', 'probability.qmd'), '# Probability\n')
  await git(checkout, ['add', '-A'])
  await git(checkout, ['commit', '-m', 'base'])

  const manager = managerOver(root, { remoteUrlFor: project => remotes[project] })
  manager.bindSource('book', checkout, { documentRoots: ['book.qmd'] })
  manager.bindSource('deck', checkout, { sourceOwner: 'book', documentRoots: ['decks/probability.qmd'] })
  await manager.sync([{ name: 'book', mainFile: 'book.qmd' }, { name: 'deck', mainFile: 'decks/probability.qmd' }])
  await manager.standOnWorkBranch('book')

  const acceptedTree = (await git(checkout, ['rev-parse', 'HEAD^{tree}'])).stdout.trim()
  const acceptedProjection = (await git(checkout, ['commit-tree', acceptedTree, '-m', 'accepted projection'])).stdout.trim()
  await git(checkout, ['push', '-q', remotes.deck, `${acceptedProjection}:refs/tlda/source/deck`])

  writeFileSync(join(checkout, 'decks', 'probability.qmd'), '# Probability\n\nEdited\n')
  const submitted = await manager.submit('book')
  await manager.closeAll()

  const proposal = `refs/tlda/proposals/daemon-a/main/${submitted.revision}`
  const projectionProposal = (await git(remotes.deck, ['for-each-ref', '--sort=-creatordate', '--format=%(objectname)', 'refs/tlda/proposals/daemon-a/main/'])).stdout.trim().split('\n')[0]
  assert.equal((await git(remotes.book, ['rev-parse', proposal])).stdout.trim(), submitted.revision)
  assert.notEqual(projectionProposal, submitted.revision, 'the projection publishes its filtered revision, not the owner revision')
  await git(checkout, ['merge-base', '--is-ancestor', acceptedProjection, projectionProposal])
  assert.match((await git(checkout, ['ls-tree', '-r', '--name-only', projectionProposal])).stdout, /^decks\/probability\.qmd$/m)
  assert.equal((await git(checkout, ['branch', '--list', 'tlda/deck'])).stdout.trim(), '',
    'the projection creates no work branch')
})

test('THE SILENT FAILURE the rejection prevents: the second project never syncs', async () => {
  // Why the guard is worth having, demonstrated rather than asserted.
  //
  // Two projects, one checkout. The checkout stands on one work branch. An edit
  // is made. One project receives it; the other refuses with
  // `not-on-work-branch` and says nothing to the person — which is exactly the
  // shape found on this machine, where a real collaborator's project had been
  // silently not syncing.
  const root = mkdtempSync(join(tmpdir(), 'tlda-shared-silence-'))
  const remote = join(root, 'server.git')
  const checkout = join(root, 'shared')
  await git(root, ['init', '--bare', remote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  await git(checkout, ['remote', 'add', 'tlda', remote])
  writeFileSync(join(checkout, 'main.md'), '# paper\n\nintroduction\n')
  await git(checkout, ['add', '-A'])
  await git(checkout, ['commit', '-m', 'base'])

  const projects = ['project-a', 'project-b']
  for (const project of projects) {
    await git(checkout, ['branch', `tlda/${project}`])
    await git(checkout, ['push', '-q', 'tlda', `HEAD:refs/tlda/source/${project}`])
  }
  // The checkout can stand on one of them.
  await git(checkout, ['checkout', '-q', 'tlda/project-a'])

  writeFileSync(join(checkout, 'main.md'), '# paper\n\nintroduction — EDITED\n')

  const results = {}
  for (const project of projects) {
    results[project] = await createGitProjectSync({
      sourceDir: checkout,
      project,
      daemonId: 'daemon-a',
      bindingId: project,
      remote,
      documentRoots: ['main.md'],
      log: { info() {}, warn() {}, error() {} },
    }).editClusterSettled()
  }

  assert.notEqual(results['project-a']?.ok, false,
    `the project whose branch is checked out syncs: ${JSON.stringify(results['project-a'])}`)
  assert.equal(results['project-b']?.status, 'not-on-work-branch',
    `and the other one does NOT, which is the silence: ${JSON.stringify(results['project-b'])}`)

  // The person's evidence that anything is wrong: none. Their edit is committed
  // and their tree is clean.
  assert.equal((await git(checkout, ['status', '--porcelain'])).stdout.trim(), '',
    'the working tree is clean, so nothing on their screen says a project was skipped')
})
