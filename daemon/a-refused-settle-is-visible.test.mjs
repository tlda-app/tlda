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

function managerOver(root, remote, onSyncRefused, onSyncRecovered = async () => {}) {
  return createGitSyncManager({
    bindingsFile: join(root, 'bindings.json'),
    daemonId: 'daemon-a',
    server: 'http://unused.test',
    remoteUrlFor: () => `file://${remote}`,
    log: quiet,
    quietMs: 10,
    onSyncRefused,
    onSyncRecovered,
  })
}

/** Wait for `read()` to satisfy `done`, or fail saying what it last saw. */
async function until(read, done, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = read()
    if (done(last)) return last
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.fail(`timed out waiting for ${what} — last saw ${JSON.stringify(last)}`)
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

/**
 * **A raised refusal has to come back down, and this is the test of that.**
 *
 * The refusal now raises the per-document sync-error sentinel, which is the one
 * surface that does not depend on who the reader is — on a deployed box the
 * chat goes to the container's OS user, so nobody reads it. An indicator that
 * can only be raised becomes wallpaper, so `onSyncRecovered` ships with it, and
 * this is the pair asserted end to end through the real watcher.
 *
 * **The shape is Skip's, not a contrivance:** a checkout that has been syncing
 * gets moved off its work branch, an edit is refused, and checking the branch
 * back out must clear the mark. A checkout that has NEVER settled has no
 * watched members, so an edit there reaches no settle at all and this path is
 * still silent for it — that gap is the file's own docstring and is unchanged.
 */
test('a refusal is raised on an edit and cleared when the branch comes back', async () => {
  const { root, dir, remote, project } = await checkoutOn('tlda/paper', 'paper')
  const refused = []
  const recovered = []
  const manager = managerOver(root, remote, e => { refused.push(e) }, e => { recovered.push(e) })
  await startDaemon(manager, project, dir)

  // Settling once on the work branch is what gives the watcher members to see.
  writeFileSync(join(dir, 'main.md'), '# paper\n\nfirst\n')
  await until(() => refused.length, n => n === 0, 'nothing refused while on the work branch', 2000)
    .catch(() => {})
  assert.deepEqual(recovered, [], 'a project that was never refused says nothing')

  // Now the failure: parked on a branch the daemon does not manage.
  await git(dir, ['checkout', '-q', '-b', 'someone-elses-branch'])
  writeFileSync(join(dir, 'main.md'), '# paper\n\nedited off the work branch\n')
  const seen = await until(() => refused, r => r.length > 0, 'the off-branch edit to be refused')
  assert.equal(seen[0].status, 'not-on-work-branch', JSON.stringify(seen[0]))
  assert.equal(seen[0].project, project)
  assert.deepEqual(recovered, [], 'the all-clear must not fire while still refused')

  // And the recovery: back on the work branch, the next edit settles.
  await git(dir, ['checkout', '-q', 'tlda/paper'])
  writeFileSync(join(dir, 'main.md'), '# paper\n\nback on the work branch\n')
  const cleared = await until(() => recovered, r => r.length > 0, 'the all-clear after recovery')
  assert.equal(cleared[0].project, project, JSON.stringify(cleared[0]))
  assert.equal(cleared.length, 1, `exactly one all-clear, not one per settle: ${JSON.stringify(cleared)}`)

  // The counterfactual that makes the count mean something: keep editing on the
  // work branch and no second all-clear appears, because nothing is refused.
  writeFileSync(join(dir, 'main.md'), '# paper\n\nstill fine\n')
  await new Promise(resolve => setTimeout(resolve, 1500))
  assert.equal(recovered.length, 1, `the all-clear is once per refusal, not per settle: ${JSON.stringify(recovered)}`)

  await manager.closeAll()
})
