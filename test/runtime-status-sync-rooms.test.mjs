// `/api/runtime-status` reports how many documents the process is holding.
//
// The distinction this file defends is between "nothing resident" and "nobody
// measured". On 2026-08-17 a server whose memory was dominated by resident rooms
// had no way to report how many it held; the question was answered from a
// two-minute log window, which reports "no rooms created" for a process holding
// hundreds, and a confidently wrong number went upward as a result.
//
// So an absent measurement must say so, and never come back as a zero.

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildRuntimeStatus } from '../server/lib/runtime-status.mjs'

test('a supplied room residency is reported', () => {
  const status = buildRuntimeStatus({ syncRooms: { resident: 7, idle: 3 } })
  assert.deepEqual(status.sync, { rooms_resident: 7, rooms_idle: 3 })
})

test('an unmeasured room residency reports unavailable, not zero', () => {
  const status = buildRuntimeStatus({})
  assert.deepEqual(status.sync, { unavailable: true })
  assert.notEqual(status.sync.rooms_resident, 0, 'must not read as "nothing resident"')
})

// Zero is a real answer and has to survive the truthiness of the object it rides in.
test('genuinely zero rooms is reported as zero, not unavailable', () => {
  const status = buildRuntimeStatus({ syncRooms: { resident: 0, idle: 0 } })
  assert.deepEqual(status.sync, { rooms_resident: 0, rooms_idle: 0 })
})
