/**
 * **A refused settle says so where a person is.**
 *
 * A checkout standing on a branch the daemon does not manage is refused
 * `not-on-work-branch`. The refusal is correct and stays — Skip's rule is *"if
 * you have a daemon-managed branch checked out, it commits, and pushes, and all
 * that shit. otherwise it doesn't."* **Nothing here pushes a branch the daemon
 * does not manage.**
 *
 * What was wrong is that the refusal was inaudible. The person edits, the daemon
 * commits, their working tree goes clean, no command errors, and the project
 * never receives a revision — so sync looks like it worked. The only trace was a
 * line in the daemon's own log file on that machine.
 *
 * **Measured on testing, 2026-08-29:** 1702 `not-on-work-branch` refusals across
 * **85 distinct projects**, the newest minutes old, none of them visible
 * anywhere but that file. 24 of the affected bindings were in the user's own
 * project directories.
 *
 * `settle` already composed the whole sentence — the project, the branch this
 * checkout is on, the managed branch it must be on, and the command that fixes
 * it. This carries that sentence to `daemon-warning`, which the server turns
 * into a chat message. No new text, no new transport.
 *
 * **The dedupe is load-bearing, not tidiness.** The refusal recurs on every
 * settle. Reporting each one would put thousands of messages in front of
 * somebody, which is a worse failure than the silence it replaces — so the third
 * test is as much the point as the first.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { createGitSyncManager } from './git-sync-manager.mjs'

const execFile = promisify(execFileCb)
const git = (cwd, args) => execFile('git', args, { cwd, encoding: 'utf8', timeout: 30_000 })
const quiet = { info() {}, warn() {}, error() {} }

/** A checkout with one commit and a bare remote, standing on `branch`. */
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

test('a checkout on an unmanaged branch reports the refusal, naming both branches', async () => {
  const { root, dir, remote, project } = await checkoutOn('main', 'paper')
  const seen = []
  const manager = managerOver(root, remote, event => { seen.push(event) })
  manager.bindSource(project, dir, { documentRoots: ['main.md'] })
  await manager.sync([{ name: project, mainFile: 'main.md' }]).catch(() => {})

  assert.equal(seen.length, 1, `exactly one refusal reported, got ${JSON.stringify(seen)}`)
  const [event] = seen
  assert.equal(event.status, 'not-on-work-branch', JSON.stringify(event))
  assert.equal(event.project, project, 'the project is named')
  // The three facts a person needs to act, all present in the message itself.
  assert.match(event.reason, /paper/, `names the project: ${event.reason}`)
  assert.match(event.reason, /\bmain\b/, `names the branch the checkout is ON: ${event.reason}`)
  assert.match(event.reason, /tlda\/paper/, `names the managed branch it must be on: ${event.reason}`)
  assert.match(event.reason, /git checkout tlda\/paper/, `and the command that fixes it: ${event.reason}`)
  await manager.closeAll()
})

test('CONTROL: a checkout on its own work branch reports nothing', async () => {
  // THE LINE THAT MUST NOT MOVE. A working checkout must stay silent — a
  // warning that fires on correct setups gets muted, and then catches nothing.
  const { root, dir, remote, project } = await checkoutOn('tlda/paper', 'paper')
  const seen = []
  const manager = managerOver(root, remote, event => { seen.push(event) })
  manager.bindSource(project, dir, { documentRoots: ['main.md'] })
  await manager.sync([{ name: project, mainFile: 'main.md' }]).catch(() => {})

  const refusals = seen.filter(event => event.status === 'not-on-work-branch')
  assert.equal(refusals.length, 0,
    `a checkout on its work branch is not refused for being on the wrong branch: ${JSON.stringify(seen)}`)
  await manager.closeAll()
})

test('the same refusal is reported ONCE, not on every settle', async () => {
  // Without this the change is a flood: the refusal recurs every settle, and
  // 1702 of them were recorded on one machine in a day.
  const { root, dir, remote, project } = await checkoutOn('main', 'paper')
  const seen = []
  const manager = managerOver(root, remote, event => { seen.push(event) })
  manager.bindSource(project, dir, { documentRoots: ['main.md'] })
  for (let i = 0; i < 3; i++) {
    await manager.headChanged(project).catch(() => {})
    writeFileSync(join(dir, 'main.md'), `# paper\n\nedit ${i}\n`)
    await manager.sync([{ name: project, mainFile: 'main.md' }]).catch(() => {})
  }
  assert.equal(seen.length, 1,
    `one report for one unchanged refusal, got ${seen.length}: ${JSON.stringify(seen.map(e => e.status))}`)
  await manager.closeAll()
})
