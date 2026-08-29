/**
 * **`--server` governs the git remote too, from the first push.**
 *
 * `projectRemoteUrl` already reads an explicit server off the binding — that was
 * the repair for `tlda project scratch --server <preview>` creating the project
 * on the preview and pushing its content to the configured server instead.
 *
 * **But the binding does not exist yet at the moment of the first push.**
 * `project link --server <host>` creates the project on `<host>` and then pushes
 * its history seed *before* `bindSource` records anything, so the read found no
 * binding, fell through to the daemon's own server, and pushed to the wrong box:
 *
 *     Created markdown project "classroom-remote-probe-0829"     <- on pic-dev
 *     fatal: repository 'https://tlda-fly…/git/classroom-remote-probe-0829/'
 *             not found                                          <- the seed push
 *
 * Measured against pic-dev on 2026-08-29. The link fails outright, so a
 * classroom cannot be set up on any box that is not the daemon's default.
 *
 * **Threading the caller's server through the push is deliberately narrower than
 * reordering the link.** `bindSource` runs after adoption is confirmed so that a
 * failed link leaves nothing behind — `fleet-daemon.mjs` cites Skip for that,
 * *"the answer is we do not lose data in this fucking app"* — and that ordering
 * must not move to fix a URL.
 *
 * The control is the ordinary case: with no `--server`, nothing changes and the
 * daemon's own server is still used.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createGitSyncManager } from './git-sync-manager.mjs'

const managerOver = root => createGitSyncManager({
  bindingsFile: join(root, 'bindings.json'),
  daemonId: 'mini-testing',
  server: 'https://tlda-fly.example.test',
  log: { info() {}, warn() {}, error() {} },
})

test('an explicit server is used for the remote even with no binding yet', async () => {
  // The exact state at seed-push time: the project has been created on the
  // named server and nothing has been bound.
  const root = mkdtempSync(join(tmpdir(), 'tlda-link-server-'))
  const manager = managerOver(root)

  const url = manager.projectRemoteUrl('paper', 'https://tlda-pic-dev.example.test')
  assert.match(url, /tlda-pic-dev\.example\.test/,
    `the server the caller named is the one pushed to: ${url}`)
  assert.doesNotMatch(url, /tlda-fly/,
    `and NOT the daemon's own server, which is the defect: ${url}`)
  assert.match(url, /\/git\/paper/, `still the project's git path: ${url}`)
})

test('CONTROL: with no override the daemon server is still used', async () => {
  // THE LINE THAT MUST NOT MOVE. Every ordinary link names no server.
  const root = mkdtempSync(join(tmpdir(), 'tlda-link-default-'))
  const url = managerOver(root).projectRemoteUrl('paper')
  assert.match(url, /tlda-fly\.example\.test/, `unchanged for an ordinary link: ${url}`)
})

test('CONTROL: a bound server still wins when no override is passed', async () => {
  // The previously-shipped behaviour this must not regress: once the binding
  // exists it carries the server, and later pushes read it from there.
  const root = mkdtempSync(join(tmpdir(), 'tlda-link-bound-'))
  const manager = managerOver(root)
  manager.bindSource('paper', join(root, 'checkout'), { server: 'https://bound.example.test' })
  const url = manager.projectRemoteUrl('paper')
  assert.match(url, /bound\.example\.test/, `the binding still governs: ${url}`)
})

test('an override beats a binding, so a relink can move a project', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-link-both-'))
  const manager = managerOver(root)
  manager.bindSource('paper', join(root, 'checkout'), { server: 'https://bound.example.test' })
  const url = manager.projectRemoteUrl('paper', 'https://named.example.test')
  assert.match(url, /named\.example\.test/, `the caller's server wins: ${url}`)
})
