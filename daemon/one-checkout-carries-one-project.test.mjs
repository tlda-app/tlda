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

const managerOver = root => createGitSyncManager({
  bindingsFile: join(root, 'bindings.json'),
  daemonId: 'daemon-a',
  server: 'http://unused.test',
  log: { info() {}, warn() {}, error() {} },
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
