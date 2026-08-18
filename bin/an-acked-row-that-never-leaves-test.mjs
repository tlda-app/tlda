#!/usr/bin/env node
//
// The server received the message, answered it, and the row is still there.
//
// This is the defect that cost somebody a night, reduced to the one property
// that actually characterises it: **a row the server has acked never leaves the
// outbox.** Depth does not return to zero, the oldest-pending timestamp never
// advances past it, and `attempts` climbs without bound.
//
// Two things it deliberately does NOT need, both of which sent me looking in the
// wrong place for an hour:
//
// - **Depth.** 1,496 queued messages are what turned a stuck row into his night,
//   but they are the consequence. The mechanism holds one row with an empty
//   queue behind it; it simply harms nobody.
// - **Size.** A 325 KB payload is his shape and not the cause. A run where every
//   push is accepted converges by construction at any size, because the gate
//   below is never consulted.
//
// What it does need is a push the server **rejects**: `handleAck` consults
// `ackGate` only for `source-change`, and a rejection that blocks rather than
// producing a retry leaves no disposition, so the gate answers "not yet"
// forever. The ack is discarded without clearing `inflight`, without touching
// the row, and **without a log line** — which is most of why this cost a night.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DaemonOutbox } from '../daemon/outbox.mjs'
import { DaemonDeliveryRuntime } from '../daemon/delivery-runtime.mjs'
import { DAEMON_OUTBOX_ID_FIELD } from '../shared/daemon-delivery.mjs'
import { createSourceChangeAckGate } from '../daemon/source-change-ack-gate.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acked-row-'))
const outbox = new DaemonOutbox(path.join(root, 'outbox.sqlite'))

// The server: it receives everything and answers everything. That is the whole
// of its role here — the defect is what the DAEMON does with an answer it has
// already received.
const received = []
let clock = Date.parse('2026-08-18T09:36:54Z')

// **The daemon's own gate, not a copy of it.** It used to be declared inline
// inside the runtime's construction, so a test could only re-implement it and
// then prove its own re-implementation. Exporting it was a refactor with no
// behaviour change, and it is what turns "I exercised the runtime" into "I
// exercised the daemon's gate".
//
// What is still stubbed is the STORE the gate consults, which is honest: the
// question here is what the runtime does when the gate says not-yet, and the
// store is how the gate is told. Reaching that state from a real rejection needs
// the degenerate stale-base -- `ok:false`, first attempt, no conflict markers,
// and no `authority.currentRevision`, without which no retry is produced and no
// disposition is ever written.
const dispositions = new Map()
const editOperationStore = {
  disposition: outboxId => dispositions.get(outboxId) || null,
  state: id => ({ state: settledOperations.has(id) ? 'settled' : 'pending' }),
}
const settledOperations = new Set()
const ackGate = createSourceChangeAckGate({ editOperationStore, outbox })

const runtime = new DaemonDeliveryRuntime({
  outbox,
  isConnected: () => true,
  isReady: () => true,
  inflightDeadlineMs: 120_000,
  now: () => clock,
  ackGate,
  send: message => {
    received.push(message)
    return true
  },
})

// Note what is NOT here: no `id` field. `daemonDeliveryPolicy` routes any
// message carrying one to DELIVERY_DIRECT, so it never enters the outbox at
// all — the queue stays empty, every assertion below passes, and the run proves
// nothing. One line from a silent green.
const rowId = 'row-that-never-leaves'
runtime.send({
  type: 'source-change',
  project: 'a-paper',
  requestId: 'req-1',
  // The gate is only consulted for a payload carrying edit operations: with
  // none, no disposition means "nothing to wait for" and the ack is honoured.
  // A rig whose saves are plain file writes can never reproduce this, because
  // those pushes carry no operations to be waiting on.
  editOperations: [{ operation: { operation_id: 'op-1' } }],
  files: [{ path: 'main.tex', content: 'his paragraph\n' }],
  [DAEMON_OUTBOX_ID_FIELD]: rowId,
})

const depth = () => outbox.pendingCount()
const oldest = () => {
  const [row] = outbox.pending(1)
  return row?.created_at ?? null
}

assert.equal(depth(), 1, 'the push is durable in the outbox before anything is sent')
const firstOldest = oldest()

// The server receives it and answers. In every sense the transport cares about,
// this message was delivered.
runtime.flushDurable()
assert.ok(received.length >= 1, 'the server received the push')
assert.equal(runtime.handleAck(rowId), false, 'the daemon refuses the ack it has already received')

// **And the row is still here.** The daemon refused its own received ack because
// the gate could not confirm the edit operations had settled, and it refused it
// silently: nothing was logged, nothing was marked, and neither end can tell
// this happened. The server counts a delivered, acked envelope; the daemon holds
// a row it will never release.
// **This assertion pins broken behaviour on purpose.** When the defect is
// fixed it will go red, and that is the signal rather than a regression: the
// run below is what a fix has to make impossible. Whoever fixes it should
// invert these three lines rather than delete the file — the recovery
// assertions at the bottom already describe the shape a fix should have.
assert.equal(depth(), 1, 'THE DEFECT: the server acked and the row never left the outbox')
assert.equal(oldest(), firstOldest, 'oldest-pending never advances past the acked row')

// Time passes. The inflight deadline releases the slot so the queue is not
// permanently pinned — that fix turned a permanent stall into a permanent
// resend loop — and the row is offered again, acked again, and refused again.
for (let attempt = 0; attempt < 3; attempt++) {
  clock += 121_000
  runtime.flushDurable()
  runtime.handleAck(rowId)
}
assert.equal(depth(), 1, 'the row is immortal: re-sent and re-refused on every deadline')
assert.ok(received.length >= 3, `the payload is re-uploaded on every cycle (${received.length} sends)`)

// The recovery that does exist, so the test says what fixes it as well as what
// breaks it: once the operations settle, the gate opens and the row leaves.
dispositions.set(rowId, { kind: 'settled', operationIds: ['op-1'] })
settledOperations.add('op-1')
clock += 121_000
runtime.flushDurable()
assert.equal(runtime.handleAck(rowId), true, 'a settled disposition opens the gate')
assert.equal(depth(), 0, 'and the acked row finally leaves')

// The runtime schedules its own flushes, so the timer has to go before the
// database does or a scheduled flush runs against a closed connection and the
// run dies AFTER passing -- a teardown error wearing a result's clothes.
clearTimeout(runtime.flushTimer)
outbox.close()
fs.rmSync(root, { recursive: true, force: true })
console.log('an acked row that never leaves: reproduced')
