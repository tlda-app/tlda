import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createRemoteGitBridge } from './remote-git-bridge.mjs'

const execFile = promisify(execFileCb)
const git = (cwd, args) => execFile('git', args, { cwd, encoding: 'utf8', timeout: 30000 })

test('remote bridge suppresses its own publication and merges a later remote edit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-remote-bridge-'))
  const remote = join(root, 'remote.git')
  const checkout = join(root, 'checkout')
  const peer = join(root, 'peer')
  await git(root, ['init', '--bare', remote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  await git(checkout, ['remote', 'add', 'origin', remote])
  writeFileSync(join(checkout, 'main.tex'), 'one\n')
  await git(checkout, ['add', 'main.tex'])
  await git(checkout, ['commit', '-m', 'one'])
  const first = (await git(checkout, ['rev-parse', 'HEAD'])).stdout.trim()
  const settled = []
  const bridge = createRemoteGitBridge({ sourceDir: checkout, onRemoteSettled: event => settled.push(event) })
  assert.equal((await bridge.publish(first)).status, 'published')
  assert.equal((await bridge.poll()).status, 'publication-acknowledged')
  assert.equal(settled.length, 0)

  await git(root, ['clone', '-b', 'main', remote, peer])
  await git(peer, ['config', 'user.name', 'peer'])
  await git(peer, ['config', 'user.email', 'peer@example.test'])
  writeFileSync(join(peer, 'other.tex'), 'remote\n')
  await git(peer, ['add', 'other.tex'])
  await git(peer, ['commit', '-m', 'remote'])
  await git(peer, ['push', 'origin', 'HEAD:main'])
  const result = await bridge.poll()
  assert.equal(result.status, 'merged')
  assert.equal(settled.length, 1)
})
