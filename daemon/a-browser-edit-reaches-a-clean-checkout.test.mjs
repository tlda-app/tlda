/**
 * **A browser edit reaches the disk when that cannot cost anything — and parks
 * when it could.**
 *
 * The accepted revision is fetched into the person's own checkout and then
 * parked at `refs/tlda/fetched/<project>`. Measured on `apptester-sync3`,
 * 2026-08-29: that ref contained the browser's `BROWSER-EDIT` while the working
 * branch and the disk did not. **Nothing was missing and no refspec was wrong**
 * — the edit was fetched and never applied.
 *
 * Parking is deliberate and most of it stays. `git-project-sync.mjs` records
 * what applying it used to mean: *"the person's dirty tree was committed
 * unasked, `checkout --force -B <branch>` moved and checked out their branch, a
 * synthetic bridge commit was written onto their HEAD, and fetched server
 * history was merged into their checkout — which left an unresolved merge in it
 * whenever the two diverged. Local is authoritative."*
 *
 * So this advances the branch in exactly one situation: **a pure fast-forward
 * onto a tree with no tracked modifications.** No merge is performed, no commit
 * is created, nothing is force-checked-out, and any divergence or any local edit
 * falls straight back to parking.
 *
 * **The two parking tests are the point of this file.** A rule that only ever
 * advanced would be indistinguishable from the behaviour that was removed, so
 * each of them asserts not merely that the branch stayed put but that **the
 * person's own bytes are still on disk afterwards.**
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { createGitProjectSync } from './git-project-sync.mjs'

const execFile = promisify(execFileCb)
const git = (cwd, args) => execFile('git', args, { cwd, encoding: 'utf8', timeout: 30_000 })
const quiet = { info() {}, warn() {}, error() {} }
const PROJECT = 'paper'

/**
 * A checkout on its work branch, plus a bare remote whose
 * `refs/tlda/source/paper` carries one further commit — the browser's edit.
 */
async function checkoutBehindTheServer() {
  const root = mkdtempSync(join(tmpdir(), 'tlda-browser-to-disk-'))
  const remote = join(root, 'server.git')
  const dir = join(root, 'work')
  await git(root, ['init', '--bare', '-b', 'main', remote])
  await git(root, ['init', '-b', 'main', dir])
  await git(dir, ['config', 'user.email', 'me@tlda'])
  await git(dir, ['config', 'user.name', 'me'])
  writeFileSync(join(dir, 'paper.md'), '# paper\n\nbaseline\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-qm', 'base'])
  await git(dir, ['checkout', '-q', '-b', `tlda/${PROJECT}`])
  await git(dir, ['push', '-q', remote, `HEAD:refs/tlda/source/${PROJECT}`])

  // The browser's edit, made somewhere else and accepted by the server.
  const away = join(root, 'browser')
  await git(root, ['clone', '-q', remote, away])
  await git(away, ['config', 'user.email', 'browser@tlda'])
  await git(away, ['config', 'user.name', 'browser'])
  await git(away, ['fetch', '-q', remote, `refs/tlda/source/${PROJECT}:refs/heads/work`])
  await git(away, ['checkout', '-q', 'work'])
  writeFileSync(join(away, 'paper.md'), '# paper\n\nbaseline\n\nBROWSER-EDIT\n')
  await git(away, ['add', '-A'])
  await git(away, ['commit', '-qm', 'browser edit'])
  await git(away, ['push', '-qf', remote, `HEAD:refs/tlda/source/${PROJECT}`])

  return { root, dir, remote }
}

const syncOver = (dir, remote) => createGitProjectSync({
  sourceDir: dir,
  project: PROJECT,
  daemonId: 'daemon-a',
  bindingId: PROJECT,
  remote,
  documentRoots: ['paper.md'],
  log: quiet,
})

const paper = dir => readFileSync(join(dir, 'paper.md'), 'utf8')

test('CLEAN AND BEHIND: the browser edit arrives on disk', async () => {
  const { dir, remote } = await checkoutBehindTheServer()
  assert.doesNotMatch(paper(dir), /BROWSER-EDIT/, 'precondition: the edit is not on disk yet')

  const result = await syncOver(dir, remote).headChanged()

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.status, 'advanced', `it advanced rather than parked: ${JSON.stringify(result)}`)
  assert.match(paper(dir), /BROWSER-EDIT/, 'the browser edit is on disk')
  // And it was a fast-forward, not a merge: no merge commit exists.
  const parents = (await git(dir, ['rev-list', '--parents', '-n', '1', 'HEAD'])).stdout.trim().split(/\s+/)
  assert.equal(parents.length, 2, `one parent, so no merge commit was created: ${parents.join(' ')}`)
})

test('DIRTY: a tracked local modification parks, and the local bytes survive', async () => {
  const { dir, remote } = await checkoutBehindTheServer()
  writeFileSync(join(dir, 'paper.md'), '# paper\n\nMY UNSAVED WORK\n')
  const before = await git(dir, ['rev-parse', 'HEAD'])

  const result = await syncOver(dir, remote).headChanged()

  assert.equal(result.status, 'observed', `parked rather than advanced: ${JSON.stringify(result)}`)
  assert.equal((await git(dir, ['rev-parse', 'HEAD'])).stdout, before.stdout, 'the branch did not move')
  assert.match(paper(dir), /MY UNSAVED WORK/, 'THEIR BYTES ARE STILL THERE — nothing was committed or overwritten')
  assert.doesNotMatch(paper(dir), /BROWSER-EDIT/, 'and the incoming edit was not applied over them')
})

test('DIVERGED: a local commit parks, and the local commit survives', async () => {
  const { dir, remote } = await checkoutBehindTheServer()
  writeFileSync(join(dir, 'paper.md'), '# paper\n\nMY OWN COMMIT\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-qm', 'mine'])
  const before = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim()

  const result = await syncOver(dir, remote).headChanged()

  assert.equal(result.status, 'observed', `parked rather than advanced: ${JSON.stringify(result)}`)
  assert.equal((await git(dir, ['rev-parse', 'HEAD'])).stdout.trim(), before, 'their commit is still HEAD')
  assert.match(paper(dir), /MY OWN COMMIT/, 'THEIR WORK IS STILL ON DISK')
  // Unmerged, unresolved, untouched — and still reachable for them to merge.
  assert.equal((await git(dir, ['ls-files', '-u'])).stdout.trim(), '', 'no unresolved merge was left behind')
})

test('PARKED STILL MEANS FETCHED: the edit is reachable even when it is not applied', async () => {
  // The obligation the parking design states — the person can see it and merge
  // it themselves. A park that also failed to fetch would be a worse bug.
  const { dir, remote } = await checkoutBehindTheServer()
  writeFileSync(join(dir, 'paper.md'), '# paper\n\nMY UNSAVED WORK\n')

  await syncOver(dir, remote).headChanged()

  const fetched = (await git(dir, ['rev-parse', `refs/tlda/fetched/${PROJECT}`])).stdout.trim()
  assert.match(fetched, /^[0-9a-f]{40}$/, 'the accepted head is parked in the checkout')
  const content = (await git(dir, ['show', `${fetched}:paper.md`])).stdout
  assert.match(content, /BROWSER-EDIT/, 'and it carries the browser edit, ready to merge')
})

test('ALREADY THERE: a checkout level with the server does nothing', async () => {
  const { dir, remote } = await checkoutBehindTheServer()
  await syncOver(dir, remote).headChanged()
  const after = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim()

  const again = await syncOver(dir, remote).headChanged()
  assert.equal(again.status, 'observed', 'nothing to advance the second time')
  assert.equal((await git(dir, ['rev-parse', 'HEAD'])).stdout.trim(), after, 'and HEAD is unchanged')
})
