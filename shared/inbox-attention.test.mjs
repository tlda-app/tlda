import test from 'node:test'
import assert from 'node:assert/strict'

import { formatAttentionReceipt } from './inbox-attention.mjs'

test('a dead recipient omits the stale inbox-status bracket', () => {
  assert.equal(
    formatAttentionReceipt({
      recipientLabel: 'gone',
      status: 'available',
      delivery: 'accepted',
      priority: 'normal',
      reason: 'recipient is dead — reanimate it to deliver',
      recipientDead: true,
    }),
    'Accepted for gone. It was not delivered: recipient is dead — reanimate it to deliver.'
  )
})

test('a live blocked recipient keeps its bracket', () => {
  assert.equal(
    formatAttentionReceipt({
      recipientLabel: 'starting',
      status: 'available',
      delivery: 'accepted',
      priority: 'normal',
      reason: 'recipient is a pending shell',
      recipientDead: false,
    }),
    'Accepted for starting [available]. It was not delivered: recipient is a pending shell.'
  )
})

test('a notified recipient is unchanged', () => {
  assert.equal(
    formatAttentionReceipt({
      recipientLabel: 'live',
      status: 'available',
      delivery: 'notified',
      priority: 'normal',
      recipientDead: false,
    }),
    'Notify queued for live [available].'
  )
})
