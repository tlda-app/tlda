import assert from 'node:assert/strict'
import test from 'node:test'

import {
  dispatchFilterEvents,
  requestEarlierChatHistory,
  setChatSubscriptionTransport,
  subscribeChat,
} from '../src/fleet/chat-subscription.mjs'

test('older chat history uses the existing filter subscription and advances its cursor', () => {
  const sent = []
  setChatSubscriptionTransport((type, payload) => sent.push({ type, payload }))
  const received = []
  const dispose = subscribeChat(
    [[['dm', 'chief13']]],
    100,
    (events, meta) => received.push({ events, meta }),
    { humanId: 'fleet:skip', humanName: 'skip', correlationKey: 'chat:shape:test' },
  )

  const first = sent[0].payload
  dispatchFilterEvents({
    subId: first.subId,
    events: [{ id: 101 }],
    reason: 'history',
    requestBefore: null,
    hasMore: true,
    nextCursor: '2026-07-29T10:00:00.000Z',
  })

  assert.equal(requestEarlierChatHistory('chat:shape:test'), true)
  assert.deepEqual(sent[1], {
    type: 'subscribe-filter',
    payload: {
      subId: first.subId,
      filter: [[['dm', 'chief13']]],
      humanId: 'fleet:skip',
      humanName: 'skip',
      window: 100,
      before: '2026-07-29T10:00:00.000Z',
    },
  })
  assert.equal(requestEarlierChatHistory('chat:shape:test'), false, 'one older page at a time')

  dispatchFilterEvents({
    subId: first.subId,
    events: [{ id: 1 }],
    reason: 'history',
    requestBefore: '2026-07-29T10:00:00.000Z',
    hasMore: false,
    nextCursor: null,
  })
  assert.equal(requestEarlierChatHistory('chat:shape:test'), false, 'stops at exhausted history')
  assert.deepEqual(received.map(({ events }) => events), [[{ id: 101 }], [{ id: 1 }]])
  dispose()
})
