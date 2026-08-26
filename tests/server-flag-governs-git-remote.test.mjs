/**
 * `--server` names the server for a command, and the git remote is part of what
 * that command does.
 *
 * It governed only the API call. So `tlda project scratch --server <preview>`
 * created the project on the preview and then pushed its content over git to
 * whatever the daemon was configured with — measured, that was Fly, and the push
 * failed with `remote: Project "…" not found` because the project only existed
 * on the preview. No content ever arrived, so no document ever mounted, which is
 * what has been blocking browser verification of document-bound UI.
 *
 * The counterfactual is the point of this file: with no server on the binding
 * the remote must still be the daemon's, or the repair would have moved every
 * ordinary link onto whatever a stray flag said.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createGitSyncManager } from '../daemon/git-sync-manager.mjs'

const DAEMON_SERVER = 'https://tlda-fly.example.ts.net'
const PREVIEW_SERVER = 'https://davids-mac-mini.example.ts.net:5190'

function managerOn(bindings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-remote-'))
  const bindingsFile = path.join(dir, 'git-bindings.json')
  fs.writeFileSync(bindingsFile, JSON.stringify(bindings))
  return createGitSyncManager({
    bindingsFile,
    daemonId: 'mini:testing',
    server: DAEMON_SERVER,
    token: 'test-token',
  })
}

/** The remote a push would use, read off the binding the same way the push does. */
function remoteFor(manager, project) {
  return manager.projectRemoteUrl(project)
}

test('a binding with no server uses the daemon’s — every ordinary link', () => {
  const manager = managerOn({ paper: { sourceDir: '/tmp/paper' } })
  const url = new URL(remoteFor(manager, 'paper'))
  assert.equal(url.origin, DAEMON_SERVER, 'unchanged for a link that named no server')
  assert.equal(url.pathname, '/git/paper')
})

test('a binding that names a server pushes THERE', () => {
  const manager = managerOn({ paper: { sourceDir: '/tmp/paper', server: PREVIEW_SERVER } })
  const url = new URL(remoteFor(manager, 'paper'))
  assert.equal(url.origin, PREVIEW_SERVER, 'the flag governs the remote, not only the API')
  assert.equal(url.pathname, '/git/paper')
})

test('the counterfactual: the old behaviour is the bug', () => {
  // What the old code did, expressed as the thing this must NOT do — the remote
  // resolving to the daemon's server while the command named the preview.
  const manager = managerOn({ paper: { sourceDir: '/tmp/paper', server: PREVIEW_SERVER } })
  const url = new URL(remoteFor(manager, 'paper'))
  assert.notEqual(url.origin, DAEMON_SERVER,
    'a command aimed at the preview must not push to the configured server')
})

test('the credentials still ride the URL', () => {
  const manager = managerOn({ paper: { sourceDir: '/tmp/paper', server: PREVIEW_SERVER } })
  const url = new URL(remoteFor(manager, 'paper'))
  assert.equal(url.password, 'test-token')
  assert.ok(url.username, 'the daemon id is the user')
})
