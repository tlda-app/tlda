import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'

import { createRemoteTransport } from './build-transport.mjs'

/**
 * **A cancel the executor never answers must still release the slot.**
 *
 * The queue's stall watchdog fires on silence and calls `cancel()` — but
 * `cancel` only SENDS a frame and waits: for the executor's `exit` frame, or
 * the socket's own close. An executor that is wedged rather than dead (socket
 * open, worker ignoring SIGTERM, no exit frame, no close) answers neither,
 * `onExit` never fires, and the build holds its queue slot until the server
 * restarts. With both slots held that way, admitted jobs starve while each
 * edit still logs as admitted.
 *
 * Measured shape on testing 2026-09-24: two corpse builds holding both worker
 * slots. The cancel fallback below bounds the wait: unanswered, the transport
 * settles locally as cancelled and the queue drains on.
 */

class WedgedSocket extends EventEmitter {
  constructor() {
    super()
    this.readyState = 1 // OPEN
    this.sent = []
  }

  send(payload) {
    this.sent.push(JSON.parse(payload))
  }

  close() {
    // Wedged: records the close, never emits it.
  }
}

function startAgainstWedged({ cancelTimeoutMs, onExit }) {
  const sockets = []
  const transport = createRemoteTransport({
    executorUrl: 'ws://executor.example:7711',
    token: 'secret',
    expectedRevision: '40eaab617',
    readProject: async () => ({ name: 'course', format: 'qmd' }),
    publishedHead: async () => 'published-revision',
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, protocol: 2, revision: '40eaab617' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    connect: () => {
      const socket = new WedgedSocket()
      sockets.push(socket)
      // Open on next tick, like a real connection establishment.
      setImmediate(() => socket.emit('open'))
      return socket
    },
    cancelTimeoutMs,
  })
  const handle = transport.start(
    { name: 'course', kind: 'build', sourceRevision: 'source-revision', acceptSeq: 1 },
    { onMessage() {}, onError() {}, onExit },
  )
  return { handle, sockets }
}

test('an unanswered cancel settles locally instead of holding the slot', { timeout: 5000 }, async () => {
  const exited = new Promise(resolve => {
    const { handle } = startAgainstWedged({ cancelTimeoutMs: 50, onExit: (...args) => resolve(args) })
    // Let the socket open and the job frame go out, then cancel into the wedge.
    setTimeout(() => handle.cancel(), 20)
  })

  const [code, signal, output] = await exited

  assert.equal(signal, 'SIGTERM')
  assert.match(String(output), /cancel.*unanswered|unanswered.*cancel/i)
})

test('an answered cancel settles from the answer, not the fallback', async () => {
  const exits = []
  const { handle, sockets } = startAgainstWedged({
    cancelTimeoutMs: 5000,
    onExit: (...args) => exits.push(args),
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  handle.cancel()
  // The executor answers with its own exit frame before any fallback could fire.
  sockets[0].emit('message', Buffer.from(JSON.stringify({ t: 'exit', code: 0, signal: null, output: 'executor said done' })))
  await new Promise(resolve => setTimeout(resolve, 20))

  assert.equal(exits.length, 1)
  assert.equal(exits[0][0], 0)
  assert.equal(exits[0][2], 'executor said done')
})
