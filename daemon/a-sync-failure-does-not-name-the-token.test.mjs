/**
 * The sync daemon's token must not reach a log or a daemon warning.
 *
 * The project remote is built with this daemon's token as URL userinfo and then
 * handed to git as an argument, so a failing git call reports a command with a
 * live credential in it. Those messages do not stay put: the refusal path logs
 * `error.message`, and the publish-failure path interpolates it into a
 * `daemon-warning` that is sent to the server.
 *
 * The error under test is a real one -- produced by really running git against
 * the manager's real remote -- and it is driven out through a real public
 * method. What is faked is only *which* git call fails, because the call that
 * leaks (`git remote set-url <url>`) fails on its own only in states that say
 * nothing about credentials.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile as execFileCb } from 'node:child_process'

import { createGitSyncManager } from './git-sync-manager.mjs'

const execFile = promisify(execFileCb)
const TOKEN = 'daemon-token-that-must-never-be-logged'

function manager(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sync-redact-'))
  const bindingsFile = join(dir, 'bindings.json')
  writeFileSync(bindingsFile, '{}')
  return createGitSyncManager({
    bindingsFile,
    daemonId: 'mini-pic-dev',
    server: 'http://127.0.0.1:1/',
    token: TOKEN,
    log: { warn() {}, info() {}, error() {} },
    ...overrides,
  })
}

/** The real thing the daemon would hit: git, given the real authed remote. */
async function realGitFailureCarryingTheRemote(remote) {
  const error = await execFile('git', ['remote', 'set-url', 'tlda', remote], { cwd: tmpdir() })
    .then(() => null, e => e)
  assert.ok(error, 'git succeeded, so there is no failure to carry a credential')
  return error
}

test('the remote carries the token and git repeats it, so there is a leak to fix', async () => {
  const remote = manager().projectRemoteUrl('qtm285')
  assert.equal(remote.includes(TOKEN), true, 'no credential in the remote; nothing downstream could leak one')

  const error = await realGitFailureCarryingTheRemote(remote)
  assert.equal(
    error.message.includes(TOKEN),
    true,
    'an unwrapped git failure no longer names the token, so the test below cannot tell a fix from a no-op',
  )
})

test('that same failure, taken through the manager, names no token', async () => {
  const remote = manager().projectRemoteUrl('qtm285')
  const real = await realGitFailureCarryingTheRemote(remote)

  const mgr = manager({ execFile: async () => { throw real } })
  const error = await mgr.pushHistorySeed('qtm285', tmpdir(), '0123456789abcdef0123456789abcdef01234567').then(() => null, e => e)

  assert.ok(error, 'the operation succeeded, so no failure was under test')
  const mask = text => String(text).split(TOKEN).join('<TOKEN>')
  assert.equal(error.message.includes(TOKEN), false, `token in message: ${mask(error.message)}`)
  assert.equal(String(error.stack || '').includes(TOKEN), false, 'token in stack')
  assert.equal(String(error.cmd || '').includes(TOKEN), false, 'token in cmd')

  // Redaction that ate the message would satisfy every assertion above.
  assert.match(error.message, /git remote set-url/, 'the failing command is no longer named')
  assert.match(error.message, /mini-pic-dev/, 'the identity that was refused is no longer named')
})
