#!/usr/bin/env node
// A rejected push must leave a git conflict in this machine's own copy, and
// must then get out of the way. Before this, the daemon discarded the server's
// three-way merge, retried once with the pre-merge text, and — if that failed
// too — blocked the project silently. The person's edits stopped reaching the
// server with no signal anywhere but this daemon's log.
//
// This is the silent-and-catastrophic case: document state drifting from
// visible state. Hence a runnable repro rather than a reading.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSourceSync } from '../daemon/source-sync.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-source-conflict-'))
const main = join(root, 'main.tex')
writeFileSync(main, 'mine\n')

const sent = []
let activeWatcher = null
const silentWatch = () => {
  const watcher = new EventEmitter()
  watcher.close = () => Promise.resolve()
  activeWatcher = watcher
  return watcher
}
const sourceSync = createSourceSync({
  sourceBindingsFile: join(root, 'missing-bindings.json'),
  log: { info() {}, error() {}, warn() {} },
  sendMsg(message) { sent.push(message); return true },
  isConnected: () => true,
  resolveEditor: () => null,
  reconcileIntervalMs: 20,
  watch: silentWatch,
})

const CONFLICTED = '<<<<<<< current\ntheirs\n=======\nmine\n>>>>>>> incoming\n'

try {
  sourceSync.bindSource('paper', root)
  sourceSync.sync([{ name: 'paper', sourceDir: root, mainFile: 'main.tex', format: 'svg' }])
  writeFileSync(main, 'mine after sync\n')
  activeWatcher.emit('change', main)
  const firstPushDeadline = Date.now() + 5000
  while (sent.length < 1 && Date.now() < firstPushDeadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(sent.length, 1, 'local change push goes out')
  const requestId = sent[0].requestId

  sourceSync.handleSourceChangeResult({
    type: 'source-change-result',
    requestId,
    project: 'paper',
    ok: false,
    status: 'stale-base',
    authority: { state: 'current', currentRevision: 'rev-server' },
    evidence: {
      classifications: [
        { path: 'main.tex', status: 'conflict', merged: Buffer.from(CONFLICTED).toString('base64') },
      ],
    },
  })

  // 1. The conflict is in the person's own file, as real git markers.
  assert.equal(readFileSync(main, 'utf8'), CONFLICTED, 'conflict written to the working copy')

  // 2. No automatic retry. Re-sending the pre-merge text would have silently
  //    clobbered the peer whose work is inside those markers.
  assert.equal(sent.length, 1, 'no retry sent while a human holds the conflict')

  // 3. And the project is NOT blocked, so resolving actually syncs. This is the
  //    half that used to strand the machine forever.
  // The watcher here is inert, so the resolving save is picked up by the
  // reconcile poll. Wait for the push rather than for a duration — a fixed
  // sleep makes this fail about one run in six on a busy machine, which is
  // worse than no test at all.
  writeFileSync(main, 'resolved by hand\n')
  const deadline = Date.now() + 5000
  while (sent.length < 2 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(sent.length, 2, 'the save that resolves the markers pushes')
  assert.equal(
    sent[1].expectedRevision,
    'rev-server',
    'and pushes against the revision the rejection taught us, not the stale one',
  )
  const resolvedFile = sent[1].files.find(f => f.path === 'main.tex')
  const resolvedText = resolvedFile.encoding === 'base64'
    ? Buffer.from(resolvedFile.content, 'base64').toString()
    : String(resolvedFile.content)
  assert.equal(resolvedText, 'resolved by hand\n', 'and sends the resolved text, not the markers')

  console.log('source conflict delivery: ok')
} finally {
  // Stop the watchers and their reconcile timers BEFORE removing the tree —
  // a pending flush that scans a deleted sourceDir throws from a timer, after
  // the assertions have already passed, and reads as a failing test.
  await sourceSync.closeAll()
  rmSync(root, { recursive: true, force: true })
}
