/**
 * **A gated-box link carries the caller's credential on the seed push — and
 * nowhere else.**
 *
 * `classroom setup` on the gated sandbox failed at the first project link:
 * the daemon built the push URL from its OWN token (`getRwToken()`), whose
 * absence builds a passwordless URL (proven: a null daemon token yields a
 * URL with no password; the live daemon token state was not read) — so git
 * prompted, and the push died with `could not read Password ... Device not
 * configured`. The caller's RW token (`--token`) reached every HTTP call but
 * never reached the Git push.
 *
 * The repair threads the caller's server AND token through the existing
 * per-call override seam (`project-source-link` → `pushHistorySeed` →
 * `projectRemoteUrl`), the same seam the earlier `--server` repair used —
 * but as a ONE-SHOT push URL argument, never as a stored remote.
 * `configureProjectRemote` writes `.git/config`, so routing the caller's RW
 * token through it would persist the credential in the linked checkout.
 * This test proves both halves: the override reaches the push, and after a
 * successful AND a failed push the repository on disk holds no caller token.
 *
 * The control is the ordinary case: with no override, the daemon's own
 * server and token still govern through the stored `tlda` remote.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createGitSyncManager } from './git-sync-manager.mjs'

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

// The manager's `execFile` seam, with real git behind it: every git call
// runs for real except the seed push itself, whose URL argument is recorded
// and then redirected at a local bare repo. So the test observes the exact
// URL the one-shot push would hand git on the gated box — credential and
// all — while the push lands locally.
function pushRecorder(bare, { failPush = false } = {}) {
  // `defaultExecFile` is promisified `child_process.execFile`: it resolves
  // `{ stdout, stderr }` and attaches `cmd` to failures. The recorder keeps
  // that contract — real git everywhere except the one-shot seed push, whose
  // URL argument is recorded (the proof) and redirected at a local bare repo
  // (or refused, for the failure half).
  const pushUrls = []
  const execFile = async (cmd, args = [], opts = {}) => {
    if (cmd === 'git' && args[0] === 'push' && typeof args[1] === 'string' && args[1].includes('/git/')) {
      pushUrls.push(args[1])
      if (failPush) {
        const error = new Error(`git push ${args[1]} ${args[2]}: simulated refusal (fixture has no live server)`)
        error.cmd = `git push ${args[1]} ${args[2]}`
        throw error
      }
      git(opts.cwd, 'push', bare, args[2])
      return { stdout: '', stderr: '' }
    }
    try {
      const stdout = execFileSync(cmd, args, { cwd: opts.cwd, encoding: 'utf8', timeout: opts.timeout })
      return { stdout: String(stdout || ''), stderr: '' }
    } catch (error) {
      error.cmd = error.cmd || `${cmd} ${args.join(' ')}`
      throw error
    }
  }
  return { pushUrls, execFile }
}

function seedRepo(root) {
  const checkout = join(root, 'checkout')
  git(root, 'init', '-b', 'main', checkout)
  git(checkout, 'config', 'user.name', 'fixture')
  git(checkout, 'config', 'user.email', 'fixture@example.test')
  return checkout
}

// The gated sandbox daemon: no token of its own, and its configured server
// is not the box the caller named.
//
// `remoteUrlFor`, when given, replaces the URL construction wholesale (the
// manager calls it instead of `new URL(...)`), so a local bare repo stands
// in for the gated preview box: the one-shot path (URL argument, no stored
// remote) is exercised without a live server.
const gatedManagerOver = (root, remoteUrlFor = null) => createGitSyncManager({
  bindingsFile: join(root, 'bindings.json'),
  daemonId: 'mini-testing',
  server: 'https://daemon-default.example.test',
  ...(remoteUrlFor ? { remoteUrlFor } : {}),
  log: { info() {}, warn() {}, error() {} },
})

test('a tokenless manager builds the passwordless URL that prompts and dies', () => {
  // THE DEFECT, pinned: no per-call override and no daemon token means the
  // push URL carries a username and no password, so git prompts for one and
  // the headless push fails with `could not read Password`.
  const root = mkdtempSync(join(tmpdir(), 'tlda-link-credential-'))
  const url = new URL(gatedManagerOver(root).projectRemoteUrl('paper'))
  assert.equal(url.hostname, 'daemon-default.example.test')
  assert.equal(url.password, '', `passwordless — this is the push that prompted: ${url}`)
})

test('a per-call token override reaches the push URL on the caller server', () => {
  // The repair: the caller's server and credential win for this push only.
  const root = mkdtempSync(join(tmpdir(), 'tlda-link-credential-'))
  const url = new URL(gatedManagerOver(root).projectRemoteUrl(
    'paper', 'https://gated-preview.example.test', 'caller-rw-token'))
  assert.equal(url.hostname, 'gated-preview.example.test',
    `the server the caller named is the one pushed to: ${url}`)
  assert.equal(url.password, 'caller-rw-token',
    `the caller's credential reaches the push: ${url}`)
  assert.match(url.pathname, /\/git\/paper/, `still the project's git path: ${url}`)
})

test('a one-shot override push writes no credential to the repository', async () => {
  // THE GATE. The seed push must use the caller's token without persisting
  // it: `git remote set-url/add tlda <URL-with-token>` writes `.git/config`,
  // which is exactly where the first version of this repair leaked. So the
  // push goes out as a one-shot URL argument with no `tlda` remote created
  // at all — after it, the checkout holds no remote and no caller token.
  const root = mkdtempSync(join(tmpdir(), 'tlda-link-credential-'))
  const bare = join(root, 'paper.git')
  git(root, 'init', '--bare', bare)
  const checkout = seedRepo(root)
  git(checkout, 'commit', '--allow-empty', '-m', 'seed')
  const head = git(checkout, 'rev-parse', 'HEAD')
  const { pushUrls, execFile } = pushRecorder(bare)
  const manager = createGitSyncManager({
    bindingsFile: join(root, 'bindings.json'),
    daemonId: 'mini-testing',
    server: 'https://daemon-default.example.test',
    execFile,
    log: { info() {}, warn() {}, error() {} },
  })
  const seed = await manager.pushHistorySeed('paper', checkout, head, 'https://gated-preview.example.test', 'caller-rw-token')
  assert.equal(git(bare, 'rev-parse', seed.ref), head, 'the seed still lands')
  // The push carried the caller's credential to the caller's server — this
  // is the URL the gated box would hand git, observed here instead of
  // inferred from `projectRemoteUrl`.
  assert.equal(pushUrls.length, 1, 'exactly one one-shot push, no remote setup')
  const pushed = new URL(pushUrls[0])
  assert.equal(pushed.hostname, 'gated-preview.example.test', `pushed to the caller server: ${pushUrls[0]}`)
  assert.equal(pushed.password, 'caller-rw-token', `the push carried the caller credential: ${pushed.username}@...`)
  assert.doesNotMatch(
    git(checkout, 'remote'),
    /tlda/,
    'no transport remote was created for a one-shot push',
  )
  assert.doesNotMatch(
    readFileSync(join(checkout, '.git/config'), 'utf8'),
    /caller-rw-token/,
    'the caller token is nowhere on disk after a successful push',
  )
})

test('a FAILED one-shot override push still writes no credential', async () => {
  // The failure half of the gate: a refused push must not leave the token
  // behind either. There is no remote to restore and no `finally` that can
  // be skipped — the token traveled as a push argument, so nothing on disk
  // can hold it.
  const root = mkdtempSync(join(tmpdir(), 'tlda-link-credential-'))
  const checkout = seedRepo(root)
  git(checkout, 'commit', '--allow-empty', '-m', 'seed')
  const head = git(checkout, 'rev-parse', 'HEAD')
  const { pushUrls, execFile } = pushRecorder(join(root, 'unused.git'), { failPush: true })
  const manager = createGitSyncManager({
    bindingsFile: join(root, 'bindings.json'),
    daemonId: 'mini-testing',
    server: 'https://daemon-default.example.test',
    execFile,
    log: { info() {}, warn() {}, error() {} },
  })
  const rejected = await manager.pushHistorySeed('paper', checkout, head, 'https://gated-preview.example.test', 'caller-rw-token')
    .then(() => null, error => error)
  assert.ok(rejected, 'the push against a missing remote fails')
  assert.equal(pushUrls.length, 1, 'the one-shot push was attempted once')
  assert.match(String(pushUrls[0]), /caller-rw-token/, 'the attempted push carried the credential')
  // The failure must never name the token either: the git layer redacts URL
  // userinfo from the thrown error before it reaches any log.
  assert.doesNotMatch(String(rejected.message || ''), /caller-rw-token/,
    `the failure names no credential: ${rejected.message}`)
  assert.doesNotMatch(String(rejected.cmd || ''), /caller-rw-token/,
    `the failure's command field names no credential`)
  assert.doesNotMatch(
    readFileSync(join(checkout, '.git/config'), 'utf8'),
    /caller-rw-token/,
    'the caller token is nowhere on disk after a failed push',
  )
})

test('CONTROL: with no override the daemon server and token still govern', () => {
  // THE LINE THAT MUST NOT MOVE. Every ordinary link names no server and no
  // token; the daemon's own values still build the URL.
  const root = mkdtempSync(join(tmpdir(), 'tlda-link-credential-'))
  const manager = createGitSyncManager({
    bindingsFile: join(root, 'bindings.json'),
    daemonId: 'mini-testing',
    server: 'https://daemon-default.example.test',
    token: 'daemon-token',
    log: { info() {}, warn() {}, error() {} },
  })
  const url = new URL(manager.projectRemoteUrl('paper'))
  assert.equal(url.hostname, 'daemon-default.example.test', `unchanged for an ordinary link: ${url}`)
  assert.equal(url.password, 'daemon-token', `the daemon's own token still governs: ${url}`)
})
