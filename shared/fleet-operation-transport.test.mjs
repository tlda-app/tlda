import assert from 'node:assert/strict'
import test from 'node:test'

import { createFleetOperationTransport } from './fleet-operation-transport.mjs'

test('keyed durable operations share an in-flight attempt and reuse identity after queued delivery', async () => {
  const calls = []
  let release
  const first = new Promise(resolve => { release = resolve })
  const transport = createFleetOperationTransport({
    name: 'proof',
    sendEphemeral: () => assert.fail('ephemeral send not expected'),
    sendDurable: (_operation, _payload, options) => {
      calls.push(options)
      return calls.length === 1 ? first : { ok: true }
    },
  })

  const a = transport.durable('login', { agent_id: 'fleet:proof' }, { coalesceKey: 'channel' })
  const overlap = transport.durable('login', { agent_id: 'fleet:proof' }, { coalesceKey: 'channel' })
  assert.equal(a, overlap)
  assert.equal(calls.length, 1)
  release({ ok: true, queued: true })
  await a

  await transport.durable('login', { agent_id: 'fleet:proof' }, { coalesceKey: 'channel' })
  assert.equal(calls.length, 2)
  assert.equal(calls[1].operationId, calls[0].operationId)
  assert.deepEqual(calls[1].envelope, calls[0].envelope)

  await transport.durable('login', { agent_id: 'fleet:proof' }, { coalesceKey: 'channel' })
  assert.equal(calls.length, 3)
  assert.notEqual(calls[2].operationId, calls[1].operationId)
})

test('keyed durable retry rejects changed payload under the same operation identity', async () => {
  const transport = createFleetOperationTransport({
    sendEphemeral: () => assert.fail('ephemeral send not expected'),
    sendDurable: async () => ({ ok: true, queued: true }),
  })
  await transport.durable('login', { agent_id: 'fleet:a' }, { coalesceKey: 'channel' })
  await assert.rejects(
    Promise.resolve().then(() => transport.durable('login', { agent_id: 'fleet:b' }, { coalesceKey: 'channel' })),
    /payload changed/
  )
})
