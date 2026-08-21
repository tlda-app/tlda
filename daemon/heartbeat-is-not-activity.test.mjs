// A heartbeat is not activity, and the delivery tier has to know the difference.
//
// Skip, 2026-08-18: "a heartbeat is not activity", and on the rest of the queue
// "we dont drop activity dude" -- a lost activity event is data loss, "mostly
// ignorable but if its the wrong event not good", and nothing at write time
// knows which one will matter. So activity is durable and only the heartbeat is
// not.
//
// The two are named as if they were the same thing. `activity-health` is a
// periodic liveness claim the server assigns to one overwritten field;
// `activity-event` is a tool call, which is one of Skip's cards. A
// classification built from the names put them in the same tier three times in
// twenty minutes. This file is the guard against the fourth.
//
// Measured the same night: 4,940 queued heartbeats carrying 18 agents' state,
// produced at ~70/min -- back to 119 within 90 seconds of wiping 5,339. The
// backlog was never the problem, so this is a rate fix and not a cleanup.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DELIVERY_DURABLE_FIFO,
  DELIVERY_LATEST_WINS,
  daemonDeliveryPolicy,
  isDurableDaemonMessage,
} from './delivery-policy.mjs'

test('the heartbeat is latest-wins, not durable', () => {
  assert.equal(daemonDeliveryPolicy({ type: 'activity-health', agent_id: 'fleet:a' }), DELIVERY_LATEST_WINS)
  assert.equal(isDurableDaemonMessage({ type: 'activity-health', agent_id: 'fleet:a' }), false,
    'a heartbeat must not be persisted and retried')
})

test('everything Skip called activity stays durable', () => {
  // "tool calls. status changes (idle etc)." Losing one of these is data loss.
  for (const type of ['activity-event', 'agent-status', 'agent-thinking']) {
    assert.equal(daemonDeliveryPolicy({ type, agent_id: 'fleet:a' }), DELIVERY_DURABLE_FIFO, type)
    assert.equal(isDurableDaemonMessage({ type, agent_id: 'fleet:a' }), true, type)
  }
})

test('the two unresolved types are untouched', () => {
  // agent-context and jsonl-index were never classified -- jsonl-index feeds
  // search, and guessing at it is how an index quietly stops being written.
  // They stay durable until someone reads their consumers.
  for (const type of ['agent-context', 'jsonl-index']) {
    assert.equal(daemonDeliveryPolicy({ type, agent_id: 'fleet:a' }), DELIVERY_DURABLE_FIFO, type)
  }
})

test('the rest of the durable set is unchanged', () => {
  for (const type of ['agent-route', 'daemon-roster', 'daemon-warning']) {
    assert.equal(daemonDeliveryPolicy({ type }), DELIVERY_DURABLE_FIFO, type)
  }
  assert.equal(daemonDeliveryPolicy({ type: 'rpc-reply', id: 'r1' }), DELIVERY_DURABLE_FIFO)
})

test('heartbeats supersede per agent rather than accumulating', () => {
  // Latest-wins keys on `${type}:${agent_id}`. If it keyed on type alone, one
  // agent's heartbeat would evict every other agent's -- 18 agents' liveness
  // collapsing to whichever reported last, which would be a worse lie than the
  // queue was.
  const a = { type: 'activity-health', agent_id: 'fleet:a' }
  const b = { type: 'activity-health', agent_id: 'fleet:b' }
  assert.equal(daemonDeliveryPolicy(a), daemonDeliveryPolicy(b))
  assert.notEqual(a.agent_id, b.agent_id)
})
