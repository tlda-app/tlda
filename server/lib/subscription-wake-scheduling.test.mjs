import assert from 'node:assert/strict'
import test from 'node:test'

import { scheduleSubscriptionWakes } from './subscription-wake-scheduling.mjs'

test('an observer-only immediate subscription does not schedule a wake', async () => {
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

  assert.deepEqual(wakeRequests, [])
  assert.deepEqual(queuedBatches, [])
})

test('an observer-only batched subscription does not schedule a wake batch', async () => {
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
  assert.deepEqual(queuedBatches, [])
})
