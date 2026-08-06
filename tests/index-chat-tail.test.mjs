import assert from 'node:assert/strict'
import test from 'node:test'

import { attachIndexChatTail } from '../src/index-chat-tail.mjs'

test('index chat follows the tail immediately and whenever rendered content changes height', () => {
  const log = { scrollTop: 0, scrollHeight: 240 }
  const rows = {}
  let resize = null
  let observed = null
  let disconnected = false

  class FakeResizeObserver {
    constructor(callback) { resize = callback }
    observe(target) { observed = target }
    disconnect() { disconnected = true }
  }

  const detach = attachIndexChatTail(log, rows, FakeResizeObserver)
  assert.equal(log.scrollTop, 240)
  assert.equal(observed, rows)

  log.scrollHeight = 420
  resize()
  assert.equal(log.scrollTop, 420)

  detach()
  assert.equal(disconnected, true)
})
