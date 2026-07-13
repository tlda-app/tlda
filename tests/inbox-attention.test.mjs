import assert from 'node:assert/strict'
import test from 'node:test'
import { decideInboxDelivery } from '../shared/inbox-attention.mjs'

const cases = [
  ['available', 'normal', 'notified'], ['available', 'important', 'notified'], ['available', 'urgent', 'notified'],
  ['busy', 'normal', 'batched'], ['busy', 'important', 'notified'], ['busy', 'urgent', 'notified'],
  ['dnd', 'normal', 'queued'], ['dnd', 'important', 'queued'], ['dnd', 'urgent', 'notified'],
]

test('inbox attention policy covers every status and priority threshold', () => {
  for (const [status, priority, delivery] of cases) {
    const result = decideInboxDelivery({ status, priority, now: 0 })
    assert.equal(result.delivery, delivery, `${status}/${priority}`)
    if (delivery === 'batched') assert.equal(result.notifyBy, '1970-01-01T00:02:00.000Z')
  }
})
