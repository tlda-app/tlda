#!/usr/bin/env node
// transport_operations must not store huge result payloads, and an omitted
// payload must NOT be replayed to a retry.
//
// The second half is the one that matters. This column is an idempotency cache:
// getTransportOperationResult feeds handleFleetWsMessage, which answers a retry
// of the same operation_id from the stored result instead of re-executing. So
// truncating a payload in place would hand a retry a mangled object it would
// believe. Omitted rows therefore carry a distinct terminal_kind, and the reader
// must decline to replay them.
//
// Context: on 2026-07-25, 3,776 `store-agents` rows averaging 5.81 MB each were
// 21.95 GB of a 28.6 GB database on a volume with ~7 hours of headroom.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dir = mkdtempSync(join(tmpdir(), 'transport-cap-'))
process.env.TLDA_FLEET_DB = join(dir, 'fleet.db')

const { FleetStore } = await import('../server/lib/fleet-store.mjs')
const store = new FleetStore(join(dir, 'fleet.db'))

const envelope = kind => ({ operation_type: kind, delivery_class: 'durable', operation_id: `op-${kind}` })

try {
  // 1. A small result is stored verbatim and replays.
  const small = { ok: true, agents: ['a', 'b'] }
  store.recordTransportOperationResult('op-small', 'chat', 'result', small, { ...envelope('chat'), operation_id: 'op-small' })
  const gotSmall = store.getTransportOperationResult('op-small', 'chat')
  assert.equal(gotSmall.kind, 'result')
  assert.deepEqual(gotSmall.payload, small, 'a small payload must round-trip untouched')

  // 2. An oversized result is recorded, but its payload is dropped.
  const huge = { ok: true, agents: Array.from({ length: 20000 }, (_, i) => ({ id: `fleet:${i}`, blurb: 'x'.repeat(64) })) }
  const hugeBytes = JSON.stringify(huge).length
  assert.ok(hugeBytes > 65536, `fixture must exceed the cap, got ${hugeBytes}`)
  store.recordTransportOperationResult('op-huge', 'store-agents', 'result', huge, { ...envelope('store-agents'), operation_id: 'op-huge' })

  const row = store.db.prepare('select terminal_kind, status, length(terminal_payload) len, terminal_payload from transport_operations where operation_id = ?').get('op-huge')
  assert.equal(row.terminal_kind, 'result', 'terminal_kind is CHECK-constrained; it must stay result/error')
  assert.equal(row.status, 'completed')
  assert.ok(row.len < 500, `stored payload must be small, got ${row.len} bytes`)
  const marker = JSON.parse(row.terminal_payload)
  assert.equal(marker.__tlda_payload_omitted, true)
  assert.equal(marker.bytes, hugeBytes, 'marker records the original size')
  assert.equal(marker.operation_type, 'store-agents')

  // 3. THE IMPORTANT ONE: a retry must not be replayed the marker.
  // handleFleetWsMessage replays only kinds 'result' and 'error'.
  const replay = store.getTransportOperationResult('op-huge', 'store-agents')
  assert.equal(replay, null, 'an omitted payload must not be replayable at all — the caller must re-execute')

  // 4. An oversized ERROR stays a failure. Deriving status from the rewritten
  // terminal_kind would have recorded this as 'completed'.
  store.recordTransportOperationResult('op-huge-err', 'store-agents', 'error', huge, { ...envelope('store-agents'), operation_id: 'op-huge-err' })
  const errRow = store.db.prepare('select terminal_kind, status from transport_operations where operation_id = ?').get('op-huge-err')
  assert.equal(errRow.terminal_kind, 'error')
  assert.equal(errRow.status, 'failed', 'an omitted error must still be recorded as failed')
  assert.equal(store.getTransportOperationResult('op-huge-err', 'store-agents'), null)

  console.log(`transport payload cap: ok (${hugeBytes} B payload stored as ${row.len} B marker)`)
} finally {
  try {
    store.close?.()
  } catch (e) {
    // Best-effort cleanup of a temp database: the assertions above already
    // decided this test's outcome, and rethrowing here would replace the real
    // failure with a close error.
    console.error('close failed:', e.message)
  }
  rmSync(dir, { recursive: true, force: true })
}
