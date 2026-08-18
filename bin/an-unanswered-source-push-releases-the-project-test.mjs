#!/usr/bin/env node
// A source-change whose reply never arrives must not pin its project forever.
//
// The failure this covers, measured on 2026-08-18: one unanswered
// source-change-result left `bregman` in `pendingProjects` from 03:15 to 04:48
// UTC. Every edit in those 93 minutes merged into the in-memory `queued` payload
// and was never sent, the daemon logged only `source change queued behind
// in-flight request`, and the author's paper stopped syncing with no error on any
// surface he looks at. A daemon restart did not clear it: `beforeSend` in
// bin/fleet-daemon.mjs re-registers every in-flight source-change from the
// durable outbox, so a brand-new process re-armed the same wedge in three
// minutes.
//
// What is asserted here:
//   1. before the deadline, nothing is released — the wedge is real, so a test
//      that only checks the release could pass against code that releases always,
//   2. at the deadline the project is released and the expiry is LOUD, as a
//      critical daemon-warning on the same per-project status path the block
//      alarm uses (the pre-existing give-up path dead-lettered three of his edits
//      silently, hours later, which is the failure mode this must not repeat),
//   3. the edits that were queued BEHIND the dead request are sent, carrying
//      their newest bytes — the deadline releases the project, it does not drop
//      what was held,
//   4. the late answer — the server is not stopped by the deadline and its reply
//      does eventually arrive for the abandoned request — is dropped rather than
//      applied to the newer base, and is logged rather than swallowed,
//   5. a later edit sends normally, i.e. the project is genuinely unpinned.
//
// The deadline is not a retry: the dead request itself is never resent, and no
// backoff or schedule is introduced anywhere in this path.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSourceSync } from '../daemon/source-sync.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-settle-deadline-'))
const main = join(root, 'main.tex')
writeFileSync(main, 'v1')

const sourceBindingsFile = join(root, 'bindings.json')
writeFileSync(sourceBindingsFile, JSON.stringify({
  paper: { bindingId: 'binding-paper', project: 'paper', sourceDir: root },
}))

const SETTLE_DEADLINE_MS = 60_000
let clock = 1_000_000
const sent = []
const warns = []
const errors = []
const silentWatch = () => {
  const w = new EventEmitter()
  w.close = () => Promise.resolve()
  return w
}
const sourceSync = createSourceSync({
  sourceChangeSettleDeadlineMs: SETTLE_DEADLINE_MS,
  sourceBindingsFile,
  log: { info() {}, error(m) { errors.push(m) }, warn(m) { warns.push(m) } },
  sendMsg(message) { sent.push(message); return true },
  isConnected: () => true,
  resolveEditor: () => null,
  reconcileIntervalMs: 50, // the reconciler is what ticks the expiry sweep
  now: () => clock,
  watch: silentWatch,
})

const sleep = ms => new Promise(r => setTimeout(r, ms))
const sourceChanges = () => sent.filter(m => m.type === 'source-change')
const unanswered = () => sent.filter(m => m.type === 'daemon-warning' && m.warning === 'source-change-unanswered')
const lastSourceChange = () => sourceChanges()[sourceChanges().length - 1]

try {
  sourceSync.sync([{ name: 'paper', sourceDir: root, mainFile: 'main.tex', format: 'svg' }])

  // An ordinary edit goes out. The server never answers it — no
  // handleSourceChangeResult call anywhere in this test for this requestId.
  writeFileSync(main, 'v1-edited')
  await sleep(400) // reconcile (50ms) → debounce (200ms) → flush
  assert.equal(sourceChanges().length, 1, 'the first edit submits')
  const abandoned = lastSourceChange()

  // The author keeps writing. This is the 93 minutes: the edit is real, it is
  // held, and nothing says so.
  writeFileSync(main, 'v2-while-wedged')
  await sleep(400)
  assert.equal(sourceChanges().length, 1, 'a later edit is queued behind the unanswered request')

  // COUNTERFACTUAL. Just short of the deadline nothing is released, so the
  // assertions below are about the deadline and not about code that releases on
  // every tick regardless.
  clock += SETTLE_DEADLINE_MS - 1
  await sleep(200)
  assert.equal(unanswered().length, 0, 'nothing expires before the deadline')
  assert.equal(sourceChanges().length, 1, 'the held edit is not released early')

  // Past the deadline the sweep runs on the next reconcile tick.
  clock += 2
  await sleep(300)

  assert.equal(unanswered().length, 1, 'expiry raises exactly one alarm')
  assert.ok(errors.some(m => /got no reply/.test(String(m))), 'expiry is also loud in the log, not only on the status path')
  const alarm = unanswered()[0]
  assert.equal(alarm.project, 'paper', 'alarm is scoped to the project (SyncErrorPill surface)')
  assert.equal(alarm.severity, 'critical', 'critical severity drives setSentinelSyncError → SyncErrorPill')
  assert.match(alarm.message, /never answered/i, 'the alarm names what happened, not a generic sync failure')

  assert.equal(sourceChanges().length, 2, 'the edits held behind the dead request are sent on release')
  const released = lastSourceChange()
  assert.notEqual(released.requestId, abandoned.requestId, 'the dead request is not resent — this is a deadline, not a retry')
  assert.equal(released.files.find(f => f.path === 'main.tex').content, 'v2-while-wedged',
    'the released payload carries the bytes that were held, not the pre-wedge ones')

  // The released request is itself in flight now, so a further edit queues behind
  // IT — that is ordinary correlation, not the wedge, and its own deadline is
  // ticking. Answer it the way a healthy server does and the project is back to
  // normal service: the next edit submits on its own.
  writeFileSync(main, 'v3-after-release')
  await sleep(400)
  assert.equal(sourceChanges().length, 2, 'an edit behind the released request queues normally')

  // THE LATE ANSWER. The server that never replied in time is not stopped by the
  // deadline — on 2026-08-18 the delay was a 14 GB rollback snapshot copy that
  // kept running — so its answer eventually arrives for a request the daemon has
  // abandoned and superseded. It must not act on the newer base: the pending
  // entry is gone, so the reply is dropped, and fix 2 above means the drop is
  // said out loud instead of vanishing.
  const beforeLate = sourceChanges().length
  const lateHandled = sourceSync.handleSourceChangeResult({
    requestId: abandoned.requestId, project: 'paper', ok: true, sourceRevision: 'rev-late',
  })
  assert.equal(lateHandled, false, 'a late answer for an expired request is not acted on')
  assert.equal(sourceChanges().length, beforeLate, 'and it does not flush anything against the newer base')
  assert.ok(warns.some(m => String(m).includes(abandoned.requestId)),
    'the dropped late answer is logged with its requestId, not swallowed')

  sourceSync.handleSourceChangeResult({ requestId: released.requestId, project: 'paper', ok: true, sourceRevision: 'rev-2' })
  assert.equal(sourceChanges().length, 3, 'the answered request flushes what queued behind it')
  assert.equal(lastSourceChange().files.find(f => f.path === 'main.tex').content, 'v3-after-release',
    'and it carries the newest bytes')

  console.log('unanswered source push releases the project: ok')
} finally {
  sourceSync.closeAll()
  rmSync(root, { recursive: true, force: true })
}
