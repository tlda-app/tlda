/**
 * The second seam. `git-sync-manager` wraps its own `execFile`, and this module
 * has a different one — so the manager's wrapper never reaches the calls that
 * actually talk to the server.
 *
 * `createGitProjectSync` is handed `remote` as a URL, not the name `tlda`: the
 * manager passes the project remote it built, carrying the daemon's token as
 * URL userinfo. `push` and `fetch` take it as an ordinary argument, so a failure
 * in either names the credential, and `fetchHead` rethrows such an error for the
 * manager to log.
 *
 * Driven with real git against a real repository and a dead port, through a
 * public method. Nothing here is stubbed.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { execFile as execFileCb } from 'node:child_process'

import { createGitProjectSync } from './git-project-sync.mjs'

const execFile = promisify(execFileCb)
const TOKEN = 'project-sync-token-that-must-never-be-logged'
// Port 1 is not listening, so the fetch fails on connect rather than on auth —
// which keeps the test off the network and off any real server.
const REMOTE = `http://mini-pic-dev:${TOKEN}@127.0.0.1:1/git/qtm285`

async function repository() {
  const dir = mkdtempSync(join(tmpdir(), 'project-sync-redact-'))
  await execFile('git', ['init', '-b', 'main', dir])
  return dir
}

function syncOver(sourceDir) {
  return createGitProjectSync({
    sourceDir,
    project: 'qtm285',
    daemonId: 'mini-pic-dev',
    bindingId: 'binding-1',
    remote: REMOTE,
    log: { warn() {}, info() {}, error() {} },
  })
}

test('the control: this git fetch really does report the credential', async () => {
  const sourceDir = await repository()
  const error = await execFile('git', ['fetch', '--no-tags', REMOTE, '+refs/tlda/source/qtm285:refs/tlda/fetched/qtm285'], { cwd: sourceDir })
    .then(() => null, e => e)
  assert.ok(error, 'the fetch succeeded, so there is no failure to carry a credential')
  assert.equal(
    error.message.includes(TOKEN),
    true,
    'an unwrapped fetch no longer names the token, so the test below cannot tell a fix from a no-op',
  )
})

test('a failing fetch through the sync module names no token', async () => {
  const sourceDir = await repository()
  const error = await syncOver(sourceDir).fetchHead().then(() => null, e => e)

  assert.ok(error, 'fetchHead resolved, so no failure was under test')
  const mask = text => String(text).split(TOKEN).join('<TOKEN>')
  assert.equal(error.message.includes(TOKEN), false, `token in message: ${mask(error.message)}`)
  assert.equal(String(error.stack || '').includes(TOKEN), false, 'token in stack')
  assert.equal(String(error.cmd || '').includes(TOKEN), false, 'token in cmd')

  // Redaction that ate the message would satisfy every assertion above.
  assert.match(error.message, /git fetch/, 'the failing command is no longer named')
  assert.match(error.message, /mini-pic-dev/, 'the identity that was refused is no longer named')
  assert.match(error.message, /127\.0\.0\.1:1/, 'the remote is no longer named')
})

test('an injected runner is redacted too, since production injects one elsewhere', async () => {
  const sourceDir = await repository()
  const real = await execFile('git', ['fetch', '--no-tags', REMOTE, '+a:b'], { cwd: sourceDir }).then(() => null, e => e)
  assert.ok(real?.message.includes(TOKEN), 'the fixture error carries no token')

  const sync = createGitProjectSync({
    sourceDir,
    project: 'qtm285',
    daemonId: 'mini-pic-dev',
    bindingId: 'binding-1',
    remote: REMOTE,
    log: { warn() {}, info() {}, error() {} },
    runGit: async () => { throw real },
  })
  const error = await sync.fetchHead().then(() => null, e => e)
  assert.ok(error, 'fetchHead resolved, so no failure was under test')
  assert.equal(error.message.includes(TOKEN), false, 'an injected runner bypasses the redaction')
})
