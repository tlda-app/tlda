/**
 * **A refused settle must not flood, and a working checkout must stay silent.**
 *
 * A checkout standing on a branch the daemon does not manage is refused
 * `not-on-work-branch`. The refusal is correct and stays — Skip's rule is *"if
 * you have a daemon-managed branch checked out, it commits, and pushes, and all
 * that shit. otherwise it doesn't."* **Nothing here pushes a branch the daemon
 * does not manage.**
 *
 * The refusal was inaudible: the person edits, the daemon commits, their tree
 * goes clean, nothing errors, and the project never receives a revision.
 * Measured on testing 2026-08-29 — **1702 refusals across 85 distinct
 * projects**, 24 of the affected bindings in the user's own project directories.
 *
 * **Reporting it from the startup sweep shipped a flood, and the first test is
 * that regression.** The sweep runs once per binding at daemon start whether or
 * not anybody touched anything, so one restart put **42 messages into root's
 * chat in 90 seconds** — and every deploy restarts the daemon.
 *
 * **What the narrowing does NOT yet buy, stated so nobody reads more into it.**
 * Reporting is now limited to the watcher path, where a person's edit is what
 * arrived. But a checkout that has never settled successfully has **no watched
 * members** — `members()` resolves through `localRef`/`fetchedRef`, none of
 * which exist for it — so the watcher observes none of its files and an edit
 * there never reaches a settle at all. **For the population this warning is
 * aimed at, it is therefore still silent.** That is a deliberate intermediate:
 * silent is strictly better than 42 messages per restart, and the remaining
 * gap is named rather than papered over.
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
const quiet = { info() {}, warn() {}, error() {} }

/** A checkout with one commit, a published head, and a bare remote. */
async function checkoutOn(branch, project) {
  const root = mkdtempSync(join(tmpdir(), 'tlda-refusal-'))
  const remote = join(root, 'server.git')
  const dir = join(root, 'work')
  await git(root, ['init', '--bare', '-b', 'main', remote])
  await git(root, ['init', '-b', 'main', dir])
  await git(dir, ['config', 'user.email', 'me@tlda'])
  await git(dir, ['config', 'user.name', 'me'])
  writeFileSync(join(dir, 'main.md'), '# paper\n\nbaseline\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-qm', 'base'])
  await git(dir, ['push', '-q', remote, `HEAD:refs/tlda/source/${project}`])
  if (branch !== 'main') await git(dir, ['checkout', '-q', '-b', branch])
  return { root, dir, remote, project }
}

function managerOver(root, remote, onSyncRefused) {
  return createGitSyncManager({
    bindingsFile: join(root, 'bindings.json'),
    daemonId: 'daemon-a',
    server: 'http://unused.test',
    remoteUrlFor: () => `file://${remote}`,
    log: quiet,
    quietMs: 10,
    onSyncRefused,
  })
}

async function startDaemon(manager, project, dir) {
  manager.bindSource(project, dir, { documentRoots: ['main.md'] })
  await manager.sync([{ name: project, mainFile: 'main.md' }]).catch(() => {})
}

test('THE FLOOD REGRESSION: a daemon startup sweep reports nothing', async () => {
  // 42 messages in 90 seconds from one restart, before this narrowing. Every
  // deploy restarts the daemon, so this is the test that keeps it quiet.
  const { root, dir, remote, project } = await checkoutOn('main', 'paper')
  const seen = []
  const manager = managerOver(root, remote, event => { seen.push(event) })
  await startDaemon(manager, project, dir)

  assert.deepEqual(seen, [],
    `startup must say nothing — nobody edited anything: ${JSON.stringify(seen)}`)
  await manager.closeAll()
})

test('CONTROL: a checkout on its own work branch is not refused at all', async () => {
  // THE LINE THAT MUST NOT MOVE. A warning that fires on correct setups gets
  // muted, and then catches nothing.
  const { root, dir, remote, project } = await checkoutOn('tlda/paper', 'paper')
  const seen = []
  const manager = managerOver(root, remote, event => { seen.push(event) })
  await startDaemon(manager, project, dir)

  assert.equal(seen.filter(event => event.status === 'not-on-work-branch').length, 0,
    `a checkout on its work branch is not refused for being on the wrong branch: ${JSON.stringify(seen)}`)
  await manager.closeAll()
})

test('the refusal carries the project, both branches, and the fix', async () => {
  // The payload the warning exists to deliver, asserted where it is composed.
  // `settle` builds this sentence; nothing downstream rewrites it, so this is
  // the text a person would receive.
  const { dir, remote, project } = await checkoutOn('main', 'paper')
  const result = await createGitProjectSync({
    sourceDir: dir,
    project,
    daemonId: `source-room:${project}`,
    bindingId: project,
    remote: `file://${remote}`,
    documentRoots: ['main.md'],
    log: quiet,
  }).editClusterSettled()

  assert.equal(result.ok, false, JSON.stringify(result))
  assert.equal(result.status, 'not-on-work-branch', JSON.stringify(result))
  assert.match(result.reason, /paper/, `names the project: ${result.reason}`)
  assert.match(result.reason, /\bmain\b/, `names the branch the checkout is ON: ${result.reason}`)
  assert.match(result.reason, /tlda\/paper/, `names the managed branch: ${result.reason}`)
  assert.match(result.reason, /git checkout tlda\/paper/, `and the fix: ${result.reason}`)
})
