import assert from 'node:assert/strict'
import test from 'node:test'

import { scheduleSubscriptionWakes } from './subscription-wake-scheduling.mjs'

test('an observer-only subscription schedules its immediate wake from the event-level delivery list', async () => {
  const wakeRequests = []
  const queuedBatches = []
  const observer = {
    recipient: 'fleet:observer',
    subscription_id: 34407,
    delivery: 'notified',
  }

  await scheduleSubscriptionWakes({
    deliveries: [observer],
    eventId: 2342370,
    text: 'between-thread traffic',
    from: 'fleet:writer',
    traceId: 'trace-1',
    priority: 'normal',
    wakeRequests,
    wakeText: ({ what, preview }) => `${what}: ${preview}`,
    agentDisplayName: async () => 'b4-live-writer',
    previewForWake: text => text,
    queueBatchWake: args => queuedBatches.push(args),
  })

  assert.deepEqual(wakeRequests, [{
    to: 'fleet:observer',
    text: 'a message from b4-live-writer: between-thread traffic',
    asker: 'fleet:writer',
    traceId: 'trace-1',
    source: { sourceEventId: 2342370, priority: 'normal', subscriptionId: 34407 },
  }])
  assert.deepEqual(queuedBatches, [])
})

test('an observer-only batched subscription schedules its batch from the event-level delivery list', async () => {
  const wakeRequests = []
  const queuedBatches = []
  const delivery = {
    recipient: 'fleet:observer',
    subscription_id: 34407,
    delivery: 'batched',
    notifyBy: '2026-08-07T12:00:00.000Z',
  }

  await scheduleSubscriptionWakes({
    deliveries: [delivery],
    eventId: 2342370,
    text: 'between-thread traffic',
    from: 'fleet:writer',
    traceId: 'trace-1',
    priority: 'normal',
    wakeRequests,
    wakeText: () => '',
    agentDisplayName: async () => 'b4-live-writer',
    previewForWake: text => text,
    queueBatchWake: args => queuedBatches.push(args),
  })

  assert.deepEqual(wakeRequests, [])
  assert.deepEqual(queuedBatches, [{
    delivery,
    eventId: 2342370,
    text: 'between-thread traffic',
    from: 'fleet:writer',
    traceId: 'trace-1',
    priority: 'normal',
  }])
})
