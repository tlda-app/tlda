import assert from 'node:assert/strict'
import test from 'node:test'
import { batchUnitMissing, decideSubscriptionDelivery, parseBatchWindowMs } from '../shared/inbox-attention.mjs'

test('a batch window requires a unit', () => {
  assert.equal(batchUnitMissing('batch(15)'), '15')
  assert.equal(parseBatchWindowMs('batch(15)'), null)
  assert.equal(decideSubscriptionDelivery({ policy: 'batch(15)' }), null)
})

test('units are honoured, seconds included', () => {
  assert.equal(parseBatchWindowMs('batch(15s)'), 15_000)
  assert.equal(parseBatchWindowMs('batch(15m)'), 900_000)
  assert.equal(parseBatchWindowMs('batch(15h)'), 54_000_000)
  assert.equal(parseBatchWindowMs('batch(500ms)'), 500)
  assert.equal(parseBatchWindowMs('batch(2.5m)'), 150_000)
})

test('long unit spellings still parse', () => {
  assert.equal(parseBatchWindowMs('batch(30 seconds)'), 30_000)
  assert.equal(parseBatchWindowMs('batch(2 hours)'), 7_200_000)
})

test('immediate, hold and default are untouched', () => {
  assert.equal(batchUnitMissing('immediate'), null)
  assert.equal(decideSubscriptionDelivery({ policy: 'immediate' }).delivery, 'notified')
  assert.equal(decideSubscriptionDelivery({ policy: 'hold' }).delivery, 'queued')
  assert.ok(parseBatchWindowMs('batch(default)') > 0)
})
