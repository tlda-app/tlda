// A fleet WS frame that arrives and is never answered must leave a record; one
// that is answered must leave nothing.
//
// This exists because nothing recorded that a frame ARRIVED, which is the gap in
// the first-load identity hang: the client sends `agents-page`, waits 45s, times
// out, and there is no server-side record either way, so "the handler stalled" and
// "it never reached the router" look identical.
//
// The second and third tests are the ones that matter most. An instrument that
// writes on every request is a per-frame cost on a path that runs for every chat,
// every event and every agent -- and one that writes repeatedly for a single stuck
// frame turns one defect into an unbounded log. Both would have to be reverted
// under load, so both are asserted against here rather than assumed.
//
// The clock and the sink are injected so this proves the logic rather than the
// timers -- a test that waits 30s of real time to observe a 30s threshold is
// slower and tests less.
import assert from 'node:assert/strict'
import test from 'node:test'

import { createFleetFrameStallTracker, resolveStallMs } from './fleet-frame-stalls.mjs'

function harness(stallMs = 1000) {
  const written = []
  let clock = 0
  const tracker = createFleetFrameStallTracker({
    stallMs,
    append: line => written.push(line),
    now: () => clock,
  })
  return { tracker, written, advance: ms => { clock += ms }, at: () => clock }
}

const ws = { _tldaAgentId: 'fleet:abc', _tldaHumanId: null, _connId: 'conn-1' }

test('a frame that arrives and is never answered is reported', () => {
  const { tracker, written, advance } = harness(1000)

  tracker.note(ws, { id: 42, type: 'agents-page' })
  advance(1500)
  assert.equal(tracker.sweep(), 1)

  assert.equal(written.length, 1)
  assert.match(written[0], /unanswered after 1500ms/)
  assert.match(written[0], /type=agents-page/)
  assert.match(written[0], /request=42/)
  assert.match(written[0], /agent=fleet:abc/)
})

test('CONTROL: a frame that is answered leaves no record at all', () => {
  const { tracker, written, advance } = harness(1000)

  const key = tracker.settle(tracker.note(ws, { id: 43, type: 'agents-page' }))
  void key
  advance(60_000)

  assert.equal(tracker.sweep(), 0)
  assert.deepEqual(written, [], 'a healthy server must write nothing')
  assert.equal(tracker.size(), 0)
})

test('CONTROL: one stuck frame produces exactly one line, not one per sweep', () => {
  const { tracker, written, advance } = harness(1000)

  tracker.note(ws, { id: 44, type: 'tasks-page' })
  advance(1500)
  assert.equal(tracker.sweep(), 1)
  advance(1500)
  assert.equal(tracker.sweep(), 0, 'already reported, must not report again')
  advance(60_000)
  assert.equal(tracker.sweep(), 0)

  assert.equal(written.length, 1)
})

test('CONTROL: a frame still inside the threshold is not reported early', () => {
  const { tracker, written, advance } = harness(1000)

  tracker.note(ws, { id: 45, type: 'agents-page' })
  advance(999)
  assert.equal(tracker.sweep(), 0)
  assert.deepEqual(written, [])
})

test('the tracker holds only in-flight frames, so it is bounded by concurrency', () => {
  const { tracker } = harness(1000)

  const keys = []
  for (let i = 0; i < 500; i++) keys.push(tracker.note(ws, { id: i, type: 'chat' }))
  assert.equal(tracker.size(), 500)
  for (const key of keys) tracker.settle(key)
  assert.equal(tracker.size(), 0, 'settled frames must not accumulate with traffic')
})

test('settle tolerates a frame that was never noted', () => {
  const { tracker } = harness(1000)
  // handleFleetWsFrame settles unconditionally in a `finally`, including for
  // frames with no id, which are never noted.
  tracker.settle(null)
  tracker.settle(undefined)
  assert.equal(tracker.size(), 0)
})

test('the threshold is configuration with a documented default, not a literal', () => {
  assert.equal(resolveStallMs({}), 30_000)
  assert.equal(resolveStallMs({ TLDA_FLEET_FRAME_STALL_MS: '5000' }), 5000)
  // A malformed or nonsense value must fall back rather than disable the sweep.
  assert.equal(resolveStallMs({ TLDA_FLEET_FRAME_STALL_MS: 'nonsense' }), 30_000)
  assert.equal(resolveStallMs({ TLDA_FLEET_FRAME_STALL_MS: '0' }), 30_000)
  assert.equal(resolveStallMs({ TLDA_FLEET_FRAME_STALL_MS: '-1' }), 30_000)
})
