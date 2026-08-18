#!/usr/bin/env node
// An edit made shortly before the daemon restarts must still reach the server.
//
// Measured on his paper, 2026-08-18: he rewrote a passage at 05:36:41Z, the
// daemon restarted at 05:38:14Z, and at 05:44 the server was still 165 bytes
// behind across three samples — flat, not lagging. Nobody was going to send it.
//
// Nothing that normally notices an edit can notice this one. chokidar was not
// running when it happened, so there is no watcher event. And startSourceWatcher
// seeds `pathFingerprints` from CURRENT disk, so the reconciler has no earlier
// fingerprint to differ against and never fires either. The restart both caused
// the loss and was the only thing that could have cleared it — another edit to
// the same file, or another restart after one.
//
// The fix compares CONTENT once per watcher start, against the revision this
// checkout last actually materialized. Fingerprints are a within-process signal
// and cannot survive a restart; the materialization journal is on disk and does.
//
// This test crosses no wire on purpose — the defect is entirely inside the
// daemon's own start-up, and `sendMsg` is where a push becomes observable. What
// it asserts is that a push is COMPOSED and carries the right bytes, which is
// the whole of what was missing.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSourceSync } from '../daemon/source-sync.mjs'

const BEFORE = 'The passage as the server has it.\n'
const AFTER = 'The passage as he rewrote it while the daemon was down.\n'

const root = mkdtempSync(join(tmpdir(), 'tlda-restart-edit-'))
const main = join(root, 'main.tex')
const sourceBindingsFile = join(root, 'bindings.json')

function entry(path, content) {
  const bytes = Buffer.from(content)
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
}

function makeSync(sent, warns) {
  const watcher = new EventEmitter()
  watcher.close = () => Promise.resolve()
  return createSourceSync({
    sourceBindingsFile,
    log: { info() {}, error() {}, warn(m) { warns.push(String(m)) } },
    sendMsg(message) { sent.push(message); return true },
    isConnected: () => true,
    resolveEditor: () => null,
    sourceChangeSettleDeadlineMs: 300_000,
    reconcileIntervalMs: 40,
    watch: () => watcher,
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const project = { name: 'paper', sourceDir: root, mainFile: 'main.tex', format: 'svg' }

// ── Session one: the checkout materializes a revision, so the daemon has a
//    durable record of what its files are supposed to contain.
writeFileSync(main, BEFORE)
const firstSent = []
const firstWarns = []
const first = makeSync(firstSent, firstWarns)
try {
  const binding = first.bindSource(project.name, root)
  first.sync([{ ...project, sourceRevision: 'rev-held', sourceManifest: ['main.tex'] }], { authoritativeRevisions: true })
  const target = entry('main.tex', BEFORE)
  const seeded = first.applyAcceptedSourceUpdate({
    project: project.name,
    bindingId: binding.bindingId,
    previousRevision: null,
    sourceRevision: 'rev-held',
    files: [{ path: 'main.tex', content: BEFORE }],
    sourceManifest: ['main.tex'],
    baseManifest: [target],
    targetManifest: [target],
    blobs: { [target.sha256]: Buffer.from(BEFORE).toString('base64') },
  })
  assert.equal(seeded.ok, true, `the checkout materialized rev-held: ${JSON.stringify(seeded)}`)
} finally {
  await first.closeAll()
}

// ── He edits while nothing is watching. No watcher event exists for this, and
//    no process is running to record a fingerprint before it.
writeFileSync(main, AFTER)

// ── Session two: the daemon comes back up.
const sent = []
const warns = []
const second = makeSync(sent, warns)
try {
  second.bindSource(project.name, root)
  second.sync([{ ...project, sourceRevision: 'rev-held', sourceManifest: ['main.tex'] }], { authoritativeRevisions: true })

  await sleep(500) // one reconcile tick (40ms) → debounce (200ms) → flush

  const pushes = sent.filter(m => m.type === 'source-change')
  assert.equal(pushes.length, 1,
    `the edit made before the restart is pushed on start-up (sent: ${JSON.stringify(sent.map(m => m.type))})`)
  assert.equal(pushes[0].files.find(f => f.path === 'main.tex')?.content, AFTER,
    'and it carries what he actually wrote, read fresh from disk')
  assert.ok(warns.some(w => w.includes('differs from the revision this checkout holds')),
    'the recovery says so rather than happening silently')

  // It must not fire twice. A start-up check that re-pushes on every reconcile
  // tick would put one project's whole source on the wire every 40ms.
  await sleep(300)
  assert.equal(sent.filter(m => m.type === 'source-change').length, 1,
    'the check runs once per watcher start, not once per reconcile tick')

  // And with disk matching the revision it holds, a restart pushes nothing —
  // otherwise every daemon start would re-push every project.
  writeFileSync(main, BEFORE)
} finally {
  await second.closeAll()
}

const quietSent = []
const third = makeSync(quietSent, [])
try {
  third.bindSource(project.name, root)
  third.sync([{ ...project, sourceRevision: 'rev-held', sourceManifest: ['main.tex'] }], { authoritativeRevisions: true })
  await sleep(500)
  assert.equal(quietSent.filter(m => m.type === 'source-change').length, 0,
    'a checkout that matches the revision it holds pushes nothing on start-up')
} finally {
  await third.closeAll()
  rmSync(root, { recursive: true, force: true })
}

console.log('an edit made before a restart is still pushed: ok')
