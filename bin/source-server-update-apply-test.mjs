#!/usr/bin/env node
import assert from 'node:assert/strict'
import { gitBlobId } from '../shared/git-blob-id.mjs'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSourceSync } from '../daemon/source-sync.mjs'

let activeWatcher = null

function silentWatch() {
  const watcher = new EventEmitter()
  watcher.close = () => Promise.resolve()
  activeWatcher = watcher
  return watcher
}

function makeSourceSync(root, sent = []) {
  return createSourceSync({
  sourceChangeSettleDeadlineMs: 300_000,
    sourceBindingsFile: join(root, 'missing-bindings.json'),
    log: { info() {}, error() {}, warn() {} },
    sendMsg(message) { sent.push(message); return true },
    isConnected: () => true,
    resolveEditor: () => null,
    reconcileIntervalMs: 20,
    watch: silentWatch,
  })
}

const root = mkdtempSync(join(tmpdir(), 'tlda-source-server-update-'))
const main = join(root, 'main.tex')
const sent = []
const sourceSync = makeSourceSync(root, sent)

function entry(path, content) {
  const bytes = Buffer.from(content)
  // Git's blob id, because that is what a revision's manifest names: a revision
  // is a commit and its tree names blobs. A fixture hashing bytes its own way
  // would be testing the materializer against a manifest no server produces.
  return { path, sha256: gitBlobId(bytes), size: bytes.length }
}

function materialization(previousContent, nextContent) {
  const target = entry('main.tex', nextContent)
  return {
    baseManifest: [entry('main.tex', previousContent)],
    targetManifest: [target],
    blobs: { [target.sha256]: Buffer.from(nextContent).toString('base64') },
  }
}

try {
  writeFileSync(main, 'base\n')
  const binding = sourceSync.bindSource('paper', root)
  sourceSync.sync([{ name: 'paper', sourceDir: root, mainFile: 'main.tex', format: 'svg', sourceRevision: 'rev-base' }], { authoritativeRevisions: true })

  const clean = sourceSync.applyAcceptedSourceUpdate({
    project: 'paper',
    bindingId: binding.bindingId,
    previousRevision: 'rev-base',
    sourceRevision: 'rev-browser',
    files: [{ path: 'main.tex', content: 'from browser\n' }],
    sourceManifest: ['main.tex'],
    ...materialization('base\n', 'from browser\n'),
  })
  assert.equal(clean.ok, true)
  assert.deepEqual(clean.applied, ['main.tex'])
  assert.deepEqual(clean.conflicted, [])
  assert.equal(readFileSync(main, 'utf8'), 'from browser\n', 'accepted browser edit writes into linked local checkout')

  writeFileSync(main, 'local concurrent edit\n')
  activeWatcher.emit('change', main)
  const conflicted = sourceSync.applyAcceptedSourceUpdate({
    project: 'paper',
    bindingId: binding.bindingId,
    previousRevision: 'rev-browser',
    sourceRevision: 'rev-peer',
    files: [{ path: 'main.tex', content: 'peer edit\n' }],
    sourceManifest: ['main.tex'],
    ...materialization('from browser\n', 'peer edit\n'),
  })
  assert.equal(conflicted.ok, false)
  assert.deepEqual(conflicted.applied, [])
  assert.deepEqual(conflicted.conflicted, ['main.tex'])
  // This block used to assert the materializer wrote `<<<<<<< local checkout`
  // into the person's file. cf6e30cf0 ("Stop the daemon writing a
  // server-computed merge over a live file") deliberately stopped doing that and
  // did not update this test, so it has been red on `main` ever since and nobody
  // noticed. The shipped behaviour is the authority: the conflict is REPORTED and
  // the local file is left exactly as its owner left it.
  const text = readFileSync(main, 'utf8')
  assert.equal(text, 'local concurrent edit\n', 'a conflict leaves the local file byte-identical to what its owner wrote')
  assert.doesNotMatch(text, /<<<<<<<|>>>>>>>/, 'no conflict markers are written into a file its owner is editing')
  assert.doesNotMatch(text, /peer edit/, 'the accepted server text is not merged over live local prose')
  assert.equal(sent.filter(message => message.type === 'daemon-warning').length, 0)

  console.log('source server update apply: ok')
} finally {
  await sourceSync.closeAll()
  rmSync(root, { recursive: true, force: true })
}
