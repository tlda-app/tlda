import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { FleetTransportOutbox, isRetryableTransportError } from '../shared/fleet-transport-outbox.mjs'
import { durableDelivery, describeDurableOutcome } from '../mcp-server/fleet-tools.mjs'

function outbox() {
  return new FleetTransportOutbox(new Database(':memory:'))
}
function enqueue(o, id = 'op-1') {
  return o.enqueue({ operationId: id, agentId: 'fleet:test', sessionId: 's1', type: 'chat', params: {}, mode: 'durable' })
}
// The two real strings, taken verbatim from the shipped outboxes.
const clientDeadline = new Error('WS request deadline exceeded after 5000ms (type=chat)')
const serverRefusal = Object.assign(new Error('fleet WS request was not accepted before deadline after 5000ms (type=chat)'), { serverRejected: true })

test('accepted row reports delivered and says nothing to the caller', () => {
  const o = outbox(); enqueue(o)
  const row = o.markAccepted('op-1', { ok: true })
  assert.equal(durableDelivery(row).delivery, 'delivered')
  assert.equal(describeDurableOutcome('chat', durableDelivery(row)), null)
})

test('a client-side deadline is retryable, stays queued, and never claims failure', () => {
  const o = outbox(); enqueue(o)
  o.markAttempt('op-1')
  const row = o.markFailure('op-1', clientDeadline, { retryable: isRetryableTransportError(clientDeadline) })
  assert.equal(row.status, 'retrying')
  const d = durableDelivery(row)
  assert.equal(d.delivery, 'unknown')
  assert.equal(d.queued, true)
  const text = describeDurableOutcome('chat', d, { waitedMs: 5000 })
  assert.match(text, /timed out after 5\.0s/)
  assert.match(text, /UNKNOWN/)
  assert.match(text, /Do not re-send/)
  assert.doesNotMatch(text, /failed|not accepted or queued/i)
})

test('a server refusal is terminal and says NOT DELIVERED', () => {
  const o = outbox(); enqueue(o)
  o.markAttempt('op-1')
  const row = o.markFailure('op-1', serverRefusal, { retryable: isRetryableTransportError(serverRefusal) })
  assert.equal(row.status, 'failed')
  const text = describeDurableOutcome('chat', durableDelivery(row))
  assert.match(text, /NOT DELIVERED/)
  assert.match(text, /Re-sending will not help/)
})

test('exhausted retries go dead and report unknown, not failure', () => {
  const o = outbox(); enqueue(o)
  let row
  for (let i = 0; i < 9; i++) {
    o.markAttempt('op-1')
    row = o.markFailure('op-1', clientDeadline, { retryable: true })
  }
  assert.equal(row.status, 'dead')
  const d = durableDelivery(row)
  assert.equal(d.delivery, 'unknown')
  const text = describeDurableOutcome('chat', d)
  assert.match(text, /UNKNOWN/)
  assert.match(text, /Re-sending is safe/)
  assert.doesNotMatch(text, /NOT DELIVERED/)
})

test('the two deadline strings are classified oppositely — the whole point', () => {
  assert.equal(isRetryableTransportError(clientDeadline), true)
  assert.equal(isRetryableTransportError(serverRefusal), false)
})
