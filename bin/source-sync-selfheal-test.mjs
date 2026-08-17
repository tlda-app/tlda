#!/usr/bin/env node
// Self-heal regression for daemon source-sync `blocked` recovery (Gate A R2).
//
// Proves the D2 fix: after stale-base contention drives a project into `blocked`,
// edits are NOT silently dropped until a restart. Instead the daemon
//   1. surfaces the block on the supported status path (critical daemon-warning →
//      SyncErrorPill), addressed to the project,
//   2. re-arms and re-submits on a bounded backoff, re-reading CURRENT disk bytes
//      so a newer local edit is never overwritten by an older queued one,
//   3. coalesces edits made during the backoff into one payload,
//   4. clears the alarm (daemon-sync-ok) once a submit lands, and
//   5. keeps the alarm visible across repeated failure with no manual restart.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSourceSync } from '../daemon/source-sync.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-selfheal-'))
const main = join(root, 'main.tex')
writeFileSync(main, 'v1')

// Fixture adapted for the current binding contract; every assertion below is the
// July original. When this test was written, `sync()` read `bindings[p.name]` as a
// STRING and fell back to the server-provided `p.sourceDir` when there was no
// binding, so a bindings file was unnecessary. Bindings are now objects
// (`{ bindingId, sourceDir }`) and the fallback is gone — a project with no
// binding is skipped outright, so the original fixture watched nothing and the
// first assertion failed on a contract change rather than on the behaviour under
// test. The binding is scaffolding; the assertions are the spec.
const sourceBindingsFile = join(root, 'bindings.json')
writeFileSync(sourceBindingsFile, JSON.stringify({
  paper: { bindingId: 'binding-paper', project: 'paper', sourceDir: root },
}))

const sent = []
const silentWatch = () => {
  const w = new EventEmitter()
  w.close = () => Promise.resolve()
  return w
}
const sourceSync = createSourceSync({
  sourceBindingsFile,
  log: { info() {}, error() {}, warn() {} },
  sendMsg(message) { sent.push(message); return true },
  isConnected: () => true,
  resolveEditor: () => null,
  reconcileIntervalMs: 50, // fingerprint reconciler injects the "edit while blocked"
  watch: silentWatch,
})

const sleep = ms => new Promise(r => setTimeout(r, ms))
const sourceChanges = () => sent.filter(m => m.type === 'source-change')
const warnings = () => sent.filter(m => m.type === 'daemon-warning')
const oks = () => sent.filter(m => m.type === 'daemon-sync-ok')
const lastSourceChange = () => sourceChanges()[sourceChanges().length - 1]

// Drive the project into `blocked`: the server rejects the request AND its bounded
// one-shot retry with stale-base carrying a moving authority revision.
function rejectStale(requestId, currentRevision) {
  sourceSync.handleSourceChangeResult({
    requestId, project: 'paper', ok: false, status: 'stale-base',
    authority: { state: 'current', currentRevision },
  })
}

try {
  sourceSync.sync([{ name: 'paper', sourceDir: root, mainFile: 'main.tex', format: 'svg' }])

  // The first source-change comes from an ordinary edit, not from a connect push.
  // The July original asserted `sync()` itself pushed — `pushWatchedFiles` at the
  // end of `sync()`. That was removed five days later by `c6bf683fe`, "Stop
  // replaying every project source on daemon connect", and does not exist on
  // `main`. Restoring it to satisfy this assertion would reinstate a connect-time
  // replay of every project's source that was deleted on purpose, so the first
  // submission is driven the way a real one is instead. Everything the test is
  // actually for — backoff, re-reading current bytes, coalescing, the alarm
  // raising and clearing — is unchanged below.
  writeFileSync(main, 'v1-edited')
  await sleep(400) // reconcile (50ms) → debounce (200ms) → flush
  assert.equal(sourceChanges().length, 1, 'an edit submits once')
  const connect = lastSourceChange()

  // First stale-base → daemon retries once (new source-change), no block yet.
  rejectStale(connect.requestId, 'rev-2')
  assert.equal(sourceChanges().length, 2, 'bounded one-shot retry re-submitted')
  assert.equal(warnings().length, 0, 'no alarm before the retry is exhausted')
  const retry = lastSourceChange()

  // Retry also stale-base → project enters `blocked`.
  rejectStale(retry.requestId, 'rev-3')
  assert.equal(sourceChanges().length, 2, 'no immediate send while blocked')
  assert.equal(warnings().length, 1, 'block raises exactly one alarm')
  const warn = warnings()[0]
  // Added to the July original: pins the narrowing this port makes. A stale-base is
  // contention the daemon recovers from, so it must NOT also arrive as the
  // `source-change-rejected` incident warning — that one fired on every rejection
  // before, which is how a recoverable base collision read as a failed save.
  // `bin/source-change-rejection-delivery-test.mjs` holds the other side: a
  // non-stale-base rejection still delivers `source-change-rejected`.
  assert.equal(warnings().filter(w => w.warning === 'source-change-rejected').length, 0,
    'a retryable stale-base does not raise the rejection incident warning')
  assert.equal(warn.project, 'paper', 'alarm is scoped to the project (SyncErrorPill surface)')
  assert.equal(warn.severity, 'critical', 'critical severity drives setSentinelSyncError → SyncErrorPill')
  assert.match(warn.message, /queued and retrying/i, 'alarm tells the author edits are queued, not lost')

  // While blocked, the author keeps editing. The fingerprint reconciler picks the
  // edit up (as a real chokidar-missed edge would); its new content must be captured
  // (re-armed), never dropped, and coalesced into the eventual single resubmit.
  writeFileSync(main, 'v2-while-blocked')
  await sleep(400) // reconcile (50ms) → debounce (200ms) → flush → still blocked → re-armed, not sent
  assert.equal(sourceChanges().length, 2, 'edits during backoff do not send while blocked')
  assert.equal(warnings().length, 1, 'still one alarm episode (no per-edit spam)')

  // The self-heal timer fires (base backoff 2s) → unblock + flush → ONE resubmit
  // carrying the NEWEST disk bytes, riding the refreshed authority revision.
  await sleep(1800)
  assert.equal(sourceChanges().length, 3, 'self-heal resubmitted exactly once, no restart')
  const resubmit = lastSourceChange()
  assert.equal(resubmit.expectedRevision, 'rev-3', 'resubmit rides the refreshed authority revision')
  const mainFile = resubmit.files.find(f => f.path === 'main.tex')
  assert.equal(mainFile.content, 'v2-while-blocked', 'resubmit re-read current disk bytes (no stale overwrite)')
  assert.equal(oks().length, 0, 'alarm still up while unresolved')

  // Repeated failure: the resubmit is stale-base → it gets one bounded fast retry
  // (the same one-shot the normal path gets), then that too is stale-base → re-blocks.
  // Through all of it the alarm stays up and nothing is dropped.
  rejectStale(resubmit.requestId, 'rev-4')
  assert.equal(sourceChanges().length, 4, 'a stale resubmit still gets one bounded fast retry')
  const fastRetry = lastSourceChange()
  assert.equal(fastRetry.expectedRevision, 'rev-4', 'fast retry rides the newest authority revision')
  rejectStale(fastRetry.requestId, 'rev-5')
  assert.equal(oks().length, 0, 'repeated failure keeps the alarm visible')
  assert.equal(warnings().length, 1, 'still the same episode — server dedups, daemon does not re-raise')

  // Next self-heal cycle (backoff grew to ~4s) lands cleanly and clears the alarm —
  // all without any manual restart or repoint.
  await sleep(4300)
  const finalResubmit = lastSourceChange()
  assert.ok(sourceChanges().length >= 5, 'backed-off self-heal fired again')
  sourceSync.handleSourceChangeResult({ requestId: finalResubmit.requestId, project: 'paper', ok: true, sourceRevision: 'rev-6' })
  assert.equal(oks().length, 1, 'clean submit lowers the sync alarm (daemon-sync-ok)')
  assert.equal(oks()[0].project, 'paper')

  console.log('source sync self-heal: ok')
} finally {
  sourceSync.closeAll()
  rmSync(root, { recursive: true, force: true })
}
