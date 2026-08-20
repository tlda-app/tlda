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
  const settled = []
  const submitted = []
  const sync = createGitProjectSync({
    sourceDir: checkout, project: 'paper', daemonId: 'daemon-a', bindingId: 'binding-a',
    onEditClusterSettled: event => settled.push(event), onSubmitted: event => submitted.push(event),
  })
  return { root, remote, checkout, applied, revision, sync, settled, submitted }
}

test('unrelated author history cleanly combines accepted and local trees and replay is inert', async () => {
  const f = await fixture({ local: { 'local.tex': 'local\n' }, accepted: { 'accepted.tex': 'accepted\n' } })
  const first = await f.sync.headChanged(f.revision)
  assert.equal(first.status, 'merged')
  assert.equal(readFileSync(join(f.checkout, 'local.tex'), 'utf8'), 'local\n')
  assert.equal(readFileSync(join(f.checkout, 'accepted.tex'), 'utf8'), 'accepted\n')
  assert.equal((await git(f.checkout, ['rev-parse', 'refs/tlda/applied/binding-a'])).stdout.trim(), f.revision)
  assert.equal(f.settled.length, 1)
  const replay = await f.sync.headChanged(f.revision)
  assert.equal(replay.status, 'already-applied')
  assert.equal(f.settled.length, 1)
})

test('unrelated author conflict stays in the checkout and withholds applied/proposal state', async () => {
  const f = await fixture({ local: { 'main.tex': 'ours\n' }, accepted: { 'main.tex': 'theirs\n' } })
  const result = await f.sync.headChanged(f.revision)
  assert.equal(result.status, 'conflicted')
  assert.deepEqual(result.conflicted, ['main.tex'])
  assert.match(readFileSync(join(f.checkout, 'main.tex'), 'utf8'), /<<<<<<< HEAD[\s\S]*ours[\s\S]*=======[\s\S]*theirs[\s\S]*>>>>>>>/)
  assert.equal((await git(f.checkout, ['rev-parse', 'refs/tlda/applied/binding-a'])).stdout.trim(), f.applied)
  assert.equal(f.settled.length, 0)
  assert.equal((await git(f.remote, ['for-each-ref', '--format=%(refname)', 'refs/tlda/proposals'])).stdout.trim(), '')
})

test('accepted mirror with no local difference produces no proposal echo', async () => {
  const f = await fixture({ accepted: { 'accepted.tex': 'accepted\n' } })
  assert.equal((await f.sync.headChanged(f.revision)).status, 'merged')
  const settled = await f.sync.editClusterSettled()
  assert.equal(settled.status, 'equal-tree')
  assert.equal(f.submitted.length, 0)
  assert.equal((await git(f.remote, ['for-each-ref', '--format=%(refname)', 'refs/tlda/proposals'])).stdout.trim(), '')
  assert.equal(existsSync(join(f.checkout, '.git', 'MERGE_HEAD')), false)
})
