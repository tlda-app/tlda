import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DELIVERY_DIRECT,
  DELIVERY_DURABLE_FIFO,
  DELIVERY_EPHEMERAL_FIFO,
  DELIVERY_LATEST_WINS,
  daemonDeliveryPolicy,
} from './delivery-policy.mjs'

test('classifies durable daemon events', () => {
  for (const type of ['source-change', 'activity-event', 'activity-health', 'terminal-chat', 'spawn-startup-failed', 'agent-status', 'agent-lifecycle', 'jsonl-index']) {
    assert.equal(daemonDeliveryPolicy({ type }), DELIVERY_DURABLE_FIFO, type)
  }
})

test('classifies terminal stream telemetry as ephemeral ordered data', () => {
  assert.equal(daemonDeliveryPolicy({ type: 'terminal-data' }), DELIVERY_EPHEMERAL_FIFO)
  assert.equal(daemonDeliveryPolicy({ type: 'terminal-size' }), DELIVERY_LATEST_WINS)
  assert.equal(daemonDeliveryPolicy({ type: 'terminal-dead' }), DELIVERY_DIRECT)
})

test('keeps correlated request response messages direct', () => {
  assert.equal(daemonDeliveryPolicy({ type: 'source-change', id: 'request-1' }), DELIVERY_DIRECT)
  assert.equal(daemonDeliveryPolicy({ type: 'rpc-reply', id: 'rpc-1' }), DELIVERY_DIRECT)
})
