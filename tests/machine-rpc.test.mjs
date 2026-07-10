import assert from 'node:assert/strict'
import test from 'node:test'
import { createMachineRpc } from '../daemon/machine-rpc.mjs'

test('machine RPC resolves replies', async () => {
  let sent = null
  const rpc = createMachineRpc({
    getPid: () => 123,
    sendMsg: msg => {
      sent = msg
      return true
    },
  })

  const promise = rpc.requestWithReply({ type: 'jsonl-index', entries: [] }, { timeoutMs: 1000 })
  assert.equal(sent.id, 'daemon:123:1')
  assert.equal(sent.type, 'jsonl-index')
  assert.equal(rpc.handleReply({ id: sent.id, result: { ok: true } }), true)
  assert.deepEqual(await promise, { ok: true })
  assert.equal(rpc.handleReply({ id: sent.id, result: { ok: false } }), false)
})

test('machine RPC preserves send-failure error', async () => {
  const rpc = createMachineRpc({
    sendMsg: () => false,
  })

  await assert.rejects(
    rpc.requestWithReply({ type: 'jsonl-index' }),
    /daemon websocket is not connected/
  )
})

test('machine RPC preserves timeout error', async () => {
  const rpc = createMachineRpc({
    sendMsg: () => true,
  })

  await assert.rejects(
    rpc.requestWithReply({ type: 'jsonl-index' }, { timeoutMs: 5 }),
    /daemon request timed out: jsonl-index/
  )
})

test('machine RPC rejects outstanding requests on close', async () => {
  const rpc = createMachineRpc({
    sendMsg: () => true,
  })

  const promise = rpc.requestWithReply({ type: 'jsonl-index' }, { timeoutMs: 1000 })
  rpc.clearPending('closed for test')
  await assert.rejects(promise, /closed for test/)
})
