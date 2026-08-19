#!/usr/bin/env node
//
// **Gate 2: there is no state a person has to clear by hand.**
//
// The candidate was `blocked`, and the real defect turned out to be next to it:
// **the alarm was raised by one carrier and lowered by the other.**
//
//   raised   proposeOverHttp → deferBlockedProject → raiseBlockedStatus
//            (critical per-document alarm, `_blockedStatusRaised = true`)
//   lowered  handleSourceChangeResult → recoverBlockedProject
//            (the SOCKET carrier's result handler, which an HTTP proposal
//             never reaches)
//
// So a project could raise the pill on the HTTP path, recover on the HTTP path,
// and **keep the pill forever** — and because `_blockedStatusRaised` gates
// re-raising, a genuine later block would then be silent as well. One flag,
// stuck in both directions, clearable by nothing.
//
// This drives it on a fresh project: fail a push so the alarm goes up, then let
// the next push succeed, and assert the alarm comes down **on its own**.
//
// It is the same severed-wire shape as the loop-back header — one end on each
// carrier, every grep healthy — which is why it is asserted on the MESSAGES the
// daemon sends rather than on the flag it keeps.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createSourceSync } from '../daemon/source-sync.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-clear-'))
const project = 'a-fresh-project'
const checkout = path.join(root, 'checkout')
fs.mkdirSync(checkout, { recursive: true })
const main = path.join(checkout, 'main.tex')
fs.writeFileSync(main, 'first\n')

const sent = []
let activeWatcher = null
const silentWatch = () => {
  const watcher = new EventEmitter()
  watcher.close = () => Promise.resolve()
  activeWatcher = watcher
  return watcher
}

// A pusher we control: the first push fails, the second succeeds. That is the
// ordinary shape of contention — somebody landed while we were writing, and then
// we got through.
let pushOutcome = { ok: false, status: 'refused-after-rebase' }
const pushes = []
const sourceSync = createSourceSync({
  sourceChangeSettleDeadlineMs: 300_000,
  sourceBindingsFile: path.join(root, 'missing-bindings.json'),
  log: { info() {}, error() {}, warn() {} },
  sendMsg(message) { sent.push(message); return true },
  isConnected: () => true,
  resolveEditor: () => null,
  reconcileIntervalMs: 20,
  watch: silentWatch,
  createSourcePushFor: () => ({
    push: async payload => { pushes.push(payload); return pushOutcome },
  }),
})

const alarms = () => sent.filter(m => m.type === 'daemon-warning' && m.project === project)
const allClears = () => sent.filter(m => m.type === 'daemon-sync-ok' && m.project === project)

try {
  sourceSync.bindSource(project, checkout)
  sourceSync.sync([{ name: project, sourceDir: checkout, mainFile: 'main.tex', format: 'svg' }])

  // ---------------------------------------------------------------------------
  // 1. A push that does not land raises the alarm. This half already worked.

  fs.writeFileSync(main, 'his revised prose\n')
  activeWatcher.emit('change', main)

  let deadline = Date.now() + 60000
  while (alarms().length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
  assert.equal(alarms().length, 1, 'a push that did not land raises one alarm')
  assert.equal(alarms()[0].severity, 'critical', 'and it is the critical per-document one')

  // ---------------------------------------------------------------------------
  // 2. **THE GATE.** The next push lands. Nothing external happens — no
  //    reconnect, no restart, no operator. The alarm must come down by itself.

  pushOutcome = { ok: true, sourceRevision: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
  const pushesBefore = pushes.length
  fs.writeFileSync(main, 'his revised prose, again\n')
  activeWatcher.emit('change', main)

  deadline = Date.now() + 60000
  while (allClears().length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))

  assert.ok(pushes.length > pushesBefore, 'precondition: the second push actually happened')
  assert.equal(allClears().length >= 1, true,
    'NO STATE A PERSON CLEARS: a successful push lowers the alarm the failed one raised, with nobody intervening')

  // And it is not merely quiet — a LATER block must be able to raise it again.
  // The flag gates re-raising, so a flag stuck true is silent in both
  // directions: no all-clear, and no alarm for the next real problem.
  pushOutcome = { ok: false, status: 'refused-after-rebase' }
  const alarmsBefore = alarms().length
  fs.writeFileSync(main, 'a third edit\n')
  activeWatcher.emit('change', main)

  deadline = Date.now() + 60000
  while (alarms().length === alarmsBefore && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
  assert.ok(alarms().length > alarmsBefore,
    'AND IT RE-ARMS: a real block after a recovery is still reported, so the all-clear did not deafen it')

  console.log('a sync that clears its own alarm: raised on a failed push, lowered by the next one, and able to raise again')
} finally {
  await sourceSync.stop?.().catch(() => {})
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}
process.exit(0)
