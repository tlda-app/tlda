import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createGitSyncManager } from './git-sync-manager.mjs'

const execFile = promisify(execFileCb)
const git = (cwd, args) => execFile('git', args, { cwd, encoding: 'utf8', timeout: 30000 })

test('bound working-copy event settles through the one Git proposal path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-git-sync-manager-'))
  const checkout = join(root, 'checkout')
  const remote = join(root, 'paper.git')
  await git(root, ['init', '--bare', remote])
  await git(root, ['init', '-b', 'main', checkout])
  await git(checkout, ['config', 'user.name', 'fixture'])
  await git(checkout, ['config', 'user.email', 'fixture@example.test'])
  writeFileSync(join(checkout, 'main.tex'), 'base\n')
  await git(checkout, ['add', 'main.tex'])
  await git(checkout, ['commit', '-m', 'base'])
  const base = (await git(checkout, ['rev-parse', 'HEAD'])).stdout.trim()
  await git(checkout, ['push', remote, `${base}:refs/tlda/source/paper`])
  const watcher = new EventEmitter()
  watcher.close = async () => {}
  const warnings = []
  const manager = createGitSyncManager({
    bindingsFile: join(root, 'bindings.json'), daemonId: 'daemon-a', server: 'http://unused.test',
    remoteUrlFor: () => remote, quietMs: 10, watch: () => watcher,
    log: { info() {}, warn(value) { warnings.push(String(value)) }, error(value) { warnings.push(String(value)) } },
  })
  manager.bindSource('paper', checkout)
  await manager.sync([{ name: 'paper', mainFile: 'main.tex' }])
  writeFileSync(join(checkout, 'main.tex'), 'settled\n')
  watcher.emit('change', join(checkout, 'main.tex'))
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
