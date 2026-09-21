import assert from 'node:assert/strict'
import test from 'node:test'
import { createRuntimeErrorCardFanin } from '../server/lib/runtime-error-card-fanin.mjs'

function harness() {
  const cards = []
  let timestamp = 100
  return {
    cards,
    advance: ms => { timestamp += ms },
    record: createRuntimeErrorCardFanin({
      docNameFromData: data => new URL(data.url).pathname.split('/')[2] || null,
      emit: (...card) => cards.push(card),
      now: () => timestamp,
    }),
  }
}

const delivered = () => new Promise(resolve => setImmediate(resolve))

test('doc-fault becomes one runtime build-card observation per document and error', async () => {
  const { record, cards } = harness()
  const entry = { ns: 'doc-fault', msg: 'ReferenceError: x is not defined', data: { url: 'https://app.test/docs/book/ch1.html' } }
  assert.equal(record(entry), true)
  assert.equal(record(entry), false, 'a repeated beacon must not send another card')
  await delivered()
  assert.deepEqual(cards, [['book', 'ReferenceError: x is not defined', 'book/ch1.html', 'runtime']])
})

test('only broken doc-capabilities become cards; unknown stays a logged observation', async () => {
  const { record, cards } = harness()
  const base = { ns: 'doc-capability', data: { url: 'https://app.test/docs/book/ch1.html' } }
  assert.equal(record({ ...base, msg: 'could not measure math', data: { ...base.data, unknown: ['math'], broken: [] } }), false)
  assert.equal(record({ ...base, msg: 'failed math', data: { ...base.data, broken: ['math'] } }), true)
  await delivered()
  assert.deepEqual(cards, [['book', 'failed math', 'book/ch1.html', 'capability']])
})

test('runtime card dedupe expires instead of permanently hiding a later observation', async () => {
  const { record, cards, advance } = harness()
  const entry = { ns: 'doc-fault', msg: 'boom', data: { url: 'https://app.test/docs/book/ch1.html' } }
  record(entry)
  advance(24 * 60 * 60 * 1000)
  assert.equal(record(entry), true)
  await delivered()
  assert.equal(cards.length, 2)
})
