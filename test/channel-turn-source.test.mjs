import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldDeliverChannelTurn } from '../mcp-server/fleet-tools.mjs'

test('direct chat and delegate events create a channel turn', () => {
  assert.equal(shouldDeliverChannelTurn({ eventType: 'chat', isDirectTarget: true }), true)
  assert.equal(shouldDeliverChannelTurn({ eventType: 'delegate', isDirectTarget: true }), true)
})

test('wiretap and non-message events do not create a channel turn', () => {
  assert.equal(shouldDeliverChannelTurn({ eventType: 'chat', isDirectTarget: false }), false)
  assert.equal(shouldDeliverChannelTurn({
    eventType: 'chat',
    fromId: 'fleet:tlda',
    isDirectTarget: true,
    data: { metadata: { type: 'build_result' } },
  }), false)
  assert.equal(shouldDeliverChannelTurn({ eventType: 'task_done', isDirectTarget: true }), false)
  assert.equal(shouldDeliverChannelTurn({ eventType: 'timer', isDirectTarget: true }), false)
})

test('channel notifications create a turn only for wake acknowledgements', () => {
  assert.equal(shouldDeliverChannelTurn({
    eventType: 'channel-notification',
    isDirectTarget: true,
    data: { metadata: { wake_ack_id: 'ack-1' } },
  }), true)
  assert.equal(shouldDeliverChannelTurn({
    eventType: 'channel-notification',
    isDirectTarget: true,
    data: { metadata: { type: 'build_result' } },
  }), false)
})
