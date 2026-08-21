import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createGitRemotes } from './git-remotes.mjs'

const execFile = promisify(execFileCb)
const git = (cwd, args) => execFile('git', args, { cwd, encoding: 'utf8' })

async function repoFixture() {
  const root = mkdtempSync(join(tmpdir(), 'tlda-git-remotes-'))
  const checkout = join(root, 'checkout')
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  writeFileSync(join(checkout, 'main.md'), '# one\n')
  await git(checkout, ['add', 'main.md'])
  await git(checkout, ['commit', '-m', 'one'])
  return { root, checkout }
}

test('one provider-neutral remote implementation adds, lists, pushes, pulls, checks out, reads, and deletes', async () => {
  const { root, checkout } = await repoFixture()
  const remote = join(root, 'remote.git')
  await git(root, ['init', '--bare', remote])
  const remotes = createGitRemotes({ sourceDir: checkout })

  await remotes.add('origin', remote)
  const pushed = await remotes.push('origin', 'main')
  assert.match(pushed.commit, /^[0-9a-f]{40}$/)
  assert.deepEqual(await remotes.list({ fetch: true }), [{
    name: 'origin', url: remote, branches: [{ name: 'main', commit: pushed.commit, selected: true }],
  }])

  await git(checkout, ['checkout', '-b', 'topic'])
  writeFileSync(join(checkout, 'main.md'), '# topic\n')
  await git(checkout, ['add', 'main.md'])
  await git(checkout, ['commit', '-m', 'topic'])
  await remotes.push('origin', 'topic')
  await git(checkout, ['checkout', 'main'])
  const checkedOut = await remotes.checkout('origin', 'topic')
  assert.equal(checkedOut.branch, 'topic')
  assert.equal((await remotes.readFile(checkedOut.commit, 'main.md')).content, '# topic\n')

  await git(checkout, ['checkout', 'main'])
  const peer = join(root, 'peer')
  await git(root, ['clone', '-b', 'main', remote, peer])
  await git(peer, ['config', 'user.name', 'peer'])
  await git(peer, ['config', 'user.email', 'peer@example.test'])
  writeFileSync(join(peer, 'peer.md'), 'peer\n')
  await git(peer, ['add', 'peer.md'])
  await git(peer, ['commit', '-m', 'peer'])
  await git(peer, ['push', 'origin', 'main'])
  const pulled = await remotes.pull('origin', 'main')
  assert.equal(pulled.commit, (await git(peer, ['rev-parse', 'HEAD'])).stdout.trim())

  await remotes.delete('origin')
  assert.deepEqual(await remotes.list(), [])
})

test('checkout refuses every dirty working tree before changing branches', async () => {
  const { root, checkout } = await repoFixture()
  const remote = join(root, 'remote.git')
  await git(root, ['init', '--bare', remote])
  const remotes = createGitRemotes({ sourceDir: checkout })
  await remotes.add('origin', remote)
  await remotes.push('origin', 'main')
  await git(checkout, ['checkout', '-b', 'topic'])
  await remotes.push('origin', 'topic')
  await git(checkout, ['checkout', 'main'])

  const unrelated = join(checkout, 'unrelated.txt')
  writeFileSync(unrelated, 'keep me\n')
  await assert.rejects(
    () => remotes.checkout('origin', 'topic'),
    /dirty working tree/,
  )
  assert.equal((await git(checkout, ['branch', '--show-current'])).stdout.trim(), 'main')
  assert.equal(readFileSync(unrelated, 'utf8'), 'keep me\n')
})
