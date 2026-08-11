import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyChannelNoticeDedupe } from '../mcp-server/fleet-tools.mjs'

test('duplicate channel content still ACKs a direct wake notification', () => {
  const deliveredIds = new Set([123])

  assert.deepEqual(classifyChannelNoticeDedupe({
    eventId: 123,
    deliveredIds,
    wakeAckId: 'trace:mcp:ack',
    isDirectTarget: true,
  }), {
    duplicate: true,
    ackDuplicateWake: true,
  })
})

test('duplicate channel content does not ACK non-wake or non-direct messages', () => {
  const deliveredIds = new Set([123])

  assert.deepEqual(classifyChannelNoticeDedupe({
    eventId: 123,
    deliveredIds,
    wakeAckId: null,
    isDirectTarget: true,
  }), {
    duplicate: true,
    ackDuplicateWake: false,
  })

  assert.deepEqual(classifyChannelNoticeDedupe({
    eventId: 123,
    deliveredIds,
    wakeAckId: 'trace:mcp:ack',
    isDirectTarget: false,
  }), {
    duplicate: true,
    ackDuplicateWake: false,
  })
})
