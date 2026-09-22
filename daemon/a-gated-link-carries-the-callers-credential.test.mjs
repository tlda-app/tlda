/**
 * **A gated-box link carries the caller's credential on the seed push.**
 *
 * `classroom setup` on the gated sandbox failed at the first project link:
 * the daemon builds the push URL from its OWN token (`getRwToken()`), which
 * is empty in the gated sandbox config — so `if (token) password` left a
 * passwordless URL, git prompted, and the push died with `could not read
 * Password ... Device not configured`. The caller's RW token (`--token`)
 * reached every HTTP call but never reached the Git push.
 *
 * The repair threads the caller's server AND token through the existing
 * per-call override seam (`project-source-link` → `pushHistorySeed` →
 * `projectRemoteUrl`), the same seam the earlier `--server` repair used.
 * This test proves the manager half: a tokenless manager builds the
 * passwordless URL (the defect), and the same manager with a per-call
 * override builds a password-carrying URL to the caller's server.
 *
 * The control is the ordinary case: with no override, the daemon's own
 * server and token still govern.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createGitSyncManager } from './git-sync-manager.mjs'

// The gated sandbox daemon: no token of its own, and its configured server
// is not the box the caller named.
const gatedManagerOver = root => createGitSyncManager({
  bindingsFile: join(root, 'bindings.json'),
  daemonId: 'mini-testing',
  server: 'https://daemon-default.example.test',
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
