import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'

import { ResilientWS } from '../shared/resilient-ws.mjs'

// Deterministic fake WebSocket: no real network, no timers of its own.
// Caller drives lifecycle by calling fakeOpen()/fakeClose()/fakeError() on
// the instance returned from the injected constructor.
class FakeWebSocket extends EventEmitter {
  constructor(url, opts) {
    super()
    this.url = url
    this.opts = opts
    this.readyState = 0 // CONNECTING
  }
  send() {}
  close() { this.readyState = 3 } // CLOSED
  terminate() { this.readyState = 3 } // CLOSED, without waiting for a handshake
  fakeOpen() { this.readyState = 1; this.emit('open') } // OPEN
  fakeClose(code = 1000, reason = '') { this.readyState = 3; this.emit('close', code, reason) }
  fakeError(err) { this.emit('error', err) }
}
FakeWebSocket.OPEN = 1
FakeWebSocket.CONNECTING = 0

function makeHarness(overrides = {}) {
  const created = []
  const events = []
  const rws = new ResilientWS({
    url: overrides.url ?? (() => 'ws://fake/'),
    label: 'test',
    initialBackoffMs: 5,
    maxBackoffMs: 20,
    random: () => 0, // deterministic backoff (no jitter spread)
    WebSocketImpl: function (url, opts) {
      const ws = new FakeWebSocket(url, opts)
      created.push(ws)
      return ws
    },
    onMessage: (msg, attemptId) => events.push(['onMessage', attemptId]),
    onOpen: (ws, attemptId) => events.push(['onOpen', attemptId]),
    onClose: (reason, attemptId) => events.push(['onClose', reason, attemptId]),
    onRetryScheduled: (attemptId, delayMs) => events.push(['retryScheduled', attemptId, delayMs]),
    onAttemptOpen: (attemptId) => events.push(['attemptOpen', attemptId]),
    log: () => {},
    ...overrides,
  })
  return { rws, created, events }
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) return false
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return true
}

test('URL-resolution failure does not mint an attempt id', () => {
  const { rws, created } = makeHarness({
    url: () => { throw new Error('config not ready') },
  })
  try {
    rws.connect()
    assert.equal(rws.attemptId, null)
    assert.equal(created.length, 0)
  } finally {
    rws.close()
  }
})

test('each constructor attempt mints exactly one new attempt id', () => {
  const { rws, created } = makeHarness()
  try {
    rws.connect()
    assert.equal(rws.attemptId, '1')
    assert.equal(created.length, 1)

    created[0].fakeClose()
    // Retry is scheduled (async); force it synchronously via reconnect() since
    // we don't want to depend on real timers in this test.
    rws._retryTimer && clearTimeout(rws._retryTimer)
    rws._retryTimer = null
    rws.connect()
    assert.equal(rws.attemptId, '2')
    assert.equal(created.length, 2)
    assert.notEqual(created[0], created[1])
  } finally {
    rws.close()
  }
})

test('error+close on one socket yields exactly one onClose transition', () => {
  const { rws, created, events } = makeHarness()
  try {
    rws.connect()
    const ws = created[0]
    ws.fakeError(new Error('boom'))
    ws.fakeClose(1006, '')
    const closeEvents = events.filter(e => e[0] === 'onClose')
    assert.equal(closeEvents.length, 1)
    assert.equal(closeEvents[0][1], 'error')
  } finally {
    rws.close()
  }
})

test('heartbeat-timeout and manual-reconnect reasons are distinct from close/error', async () => {
  const { rws, created, events } = makeHarness({ heartbeatTimeoutMs: 10 })
  try {
    rws.connect()
    created[0].fakeOpen()
    assert.equal(await waitFor(() => events.some(e => e[0] === 'onClose')), true)
    const closeEvents = events.filter(e => e[0] === 'onClose')
    assert.equal(closeEvents.length, 1)
    assert.equal(closeEvents[0][1], 'heartbeat-timeout')
  } finally {
    rws.close()
  }
})

test('queued liveness after a starved heartbeat timer keeps the same OPEN generation', async () => {
  const { rws, created, events } = makeHarness({ heartbeatTimeoutMs: 10 })
  let keepAlive = null
  try {
    rws.connect()
    created[0].fakeOpen()
    setTimeout(() => {
      created[0].emit('ping')
      keepAlive = setInterval(() => created[0].emit('ping'), 5)
    }, 10)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(created.length, 1)
    assert.equal(rws.attemptId, '1')
    assert.equal(rws.connected, true)
    assert.equal(events.filter(e => e[0] === 'retryScheduled').length, 0)
    assert.equal(events.filter(e => e[0] === 'onClose').length, 0)
  } finally {
    if (keepAlive) clearInterval(keepAlive)
    rws.close()
  }
})

test('genuinely silent OPEN socket still reconnects after heartbeat timeout', async () => {
  const { rws, created, events } = makeHarness({ heartbeatTimeoutMs: 10 })
  try {
    rws.connect()
    created[0].fakeOpen()
    assert.equal(await waitFor(() => created.length === 2), true)
    assert.equal(created.length, 2)
    assert.equal(rws.attemptId, '2')
    assert.ok(events.some(e => e[0] === 'onClose' && e[1] === 'heartbeat-timeout' && e[2] === '1'))
    assert.ok(events.some(e => e[0] === 'retryScheduled' && e[1] === '1'))
  } finally {
    rws.close()
  }
})

test('manual reconnect() reports reason manual-reconnect', () => {
  const { rws, created, events } = makeHarness()
  try {
    rws.connect()
    created[0].fakeOpen()
    rws.reconnect()
    const closeEvents = events.filter(e => e[0] === 'onClose')
    assert.equal(closeEvents.length, 1)
    assert.equal(closeEvents[0][1], 'manual-reconnect')
  } finally {
    rws.close()
  }
})

test('a socket stuck CONNECTING times out and retries as a failed attempt', () => {
  const { rws, created, events } = makeHarness({
    connectAttemptTimeoutMs: 10,
  })
  rws.connect()
  assert.equal(created.length, 1)
  assert.equal(rws.attemptId, '1')

  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const check = () => {
      if (created.length < 2 && Date.now() - startedAt < 1_000) {
        setTimeout(check, 10)
        return
      }
      try {
        assert.equal(created.length, 2, 'connect-timeout should schedule a replacement socket')
        assert.equal(rws.attemptId, '2')
        const closeEvents = events.filter(e => e[0] === 'onClose')
        assert.ok(closeEvents.some(e => e[1] === 'connect-timeout' && e[2] === '1'))
        const retryEvents = events.filter(e => e[0] === 'retryScheduled')
        assert.ok(retryEvents.some(e => e[1] === '1'), 'retry is attributed to the timed-out attempt')
        rws.close()
        resolve()
      } catch (e) {
        rws.close()
        reject(e)
      }
    }
    setTimeout(check, 10)
  })
})

test('default durable connection may open after 5s without minting a retry generation', async () => {
  const { rws, created, events } = makeHarness()
  try {
    rws.connect()
    assert.equal(created.length, 1)
    await new Promise(resolve => setTimeout(resolve, 5_100))
    assert.equal(created.length, 1, 'default connection attempt must not be replaced after 5s')
    assert.equal(rws.attemptId, '1')
    created[0].fakeOpen()
    assert.equal(rws.connected, true)
    assert.equal(events.filter(e => e[0] === 'retryScheduled').length, 0)
    assert.deepEqual(events.filter(e => e[0] === 'attemptOpen').map(e => e[1]), ['1'])
  } finally {
    rws.close()
  }
})

test('retry-scheduled carries the just-ended attempt id and a delay; next opened attempt is the following id', () => {
  const { rws, created, events } = makeHarness()
  try {
    rws.connect()
    assert.equal(rws.attemptId, '1')
    created[0].fakeOpen()
    events.length = 0
    created[0].fakeClose(1006, '')

    const retryEvents = events.filter(e => e[0] === 'retryScheduled')
    assert.equal(retryEvents.length, 1)
    assert.equal(retryEvents[0][1], '1') // just-ended attempt
    assert.equal(typeof retryEvents[0][2], 'number')

    rws._retryTimer && clearTimeout(rws._retryTimer)
    rws._retryTimer = null
    rws.connect()
    created[1].fakeOpen()
    const attemptOpenEvents = events.filter(e => e[0] === 'attemptOpen')
    assert.equal(attemptOpenEvents[attemptOpenEvents.length - 1][1], '2')
  } finally {
    rws.close()
  }
})

test('a late close from a superseded socket stays labeled with its own attempt id, and fabricates no attempt-2 detection', () => {
  const { rws, created, events } = makeHarness()
  try {
    rws.connect()
    const ws1 = created[0]
    ws1.fakeError(new Error('boom')) // ws1 errors -> cleanup(ws1, 'error', '1') -> retry scheduled

    const firstCloseEvents = events.filter(e => e[0] === 'onClose')
    assert.equal(firstCloseEvents.length, 1)
    assert.equal(firstCloseEvents[0][1], 'error')
    assert.equal(firstCloseEvents[0][2], '1', 'labeled with attempt 1, the socket that actually errored')

    rws._retryTimer && clearTimeout(rws._retryTimer)
    rws._retryTimer = null
    rws.connect() // attempt 2 constructed; ws1 object still exists (a stale reference elsewhere)
    const ws2 = created[1]
    ws2.fakeOpen()

    // ws2's own events must never be mislabeled as attempt 1 -- checked BEFORE
    // clearing, since these fired at ws2.fakeOpen() above.
    const attemptOpenEvents = events.filter(e => e[0] === 'attemptOpen')
    assert.equal(attemptOpenEvents[attemptOpenEvents.length - 1][1], '2')
    const onOpenEventsBeforeClear = events.filter(e => e[0] === 'onOpen')
    assert.equal(onOpenEventsBeforeClear[onOpenEventsBeforeClear.length - 1][1], '2')

    events.length = 0

    // ws1 (superseded, already cleaned up) fires a late close. Node's `ws` guarantees
    // at most one of close/error normally, but this simulates a library edge case.
    ws1.fakeClose(1006, '')

    // _cleanup's identity guard (this._ws !== ws) means this late event from a
    // socket that is no longer this._ws must produce NO further onClose call --
    // not a phantom second transition, and certainly not one mislabeled as attempt 2.
    const closeEvents = events.filter(e => e[0] === 'onClose')
    assert.equal(closeEvents.length, 0, 'a late event from a superseded, already-cleaned-up socket fires no further transition')
    // Nor may it schedule a spurious retry on top of the current, healthy generation.
    const retryEvents = events.filter(e => e[0] === 'retryScheduled')
    assert.equal(retryEvents.length, 0, 'a late event from a superseded socket must not schedule a retry either')
    const onOpenEvents = onOpenEventsBeforeClear
    assert.equal(onOpenEvents[onOpenEvents.length - 1][1], '2')
  } finally {
    rws.close()
  }
})

test('a throwing WebSocket constructor still carries the minted attempt id in the retry trace', () => {
  const { rws, events } = makeHarness({
    WebSocketImpl: function () { throw new Error('ENETUNREACH') },
  })
  try {
    rws.connect()
    assert.equal(rws.attemptId, '1', 'the attempt WAS minted -- this is a real connection attempt, not URL resolution')
    const retryEvents = events.filter(e => e[0] === 'retryScheduled')
    assert.equal(retryEvents.length, 1)
    assert.equal(retryEvents[0][1], '1', 'a throwing constructor is attributed to the attempt it belongs to, not null')
  } finally {
    rws.close()
  }
})

test('URL-resolution failure after a prior socket schedules retry with no attempt id, not the prior one', () => {
  let shouldThrow = false
  const { rws, created, events } = makeHarness({
    url: () => { if (shouldThrow) throw new Error('config vanished'); return 'ws://fake/' },
  })
  try {
    rws.connect()
    assert.equal(rws.attemptId, '1')
    created[0].fakeClose(1006, '')
    rws._retryTimer && clearTimeout(rws._retryTimer)
    rws._retryTimer = null
    events.length = 0

    shouldThrow = true
    rws.connect() // URL resolution fails this time
    assert.equal(created.length, 1, 'no second socket was constructed')

    const retryEvents = events.filter(e => e[0] === 'retryScheduled')
    assert.equal(retryEvents.length, 1)
    assert.equal(retryEvents[0][1], null, 'a URL-resolution failure must not be attributed to the previous attempt id')
  } finally {
    rws.close()
  }
})

test('each socket generation reports its own captured attempt id on open/message, independent of connect() order', () => {
  const { rws, created, events } = makeHarness()
  try {
    rws.connect()
    created[0].fakeOpen()
    created[0].emit('message', Buffer.from(JSON.stringify({ type: 'ping-ish' })))

    const attempt1Events = events.filter(e => e[2] === '1' || (e[0] === 'onOpen' && e[1] === '1') || (e[0] === 'onMessage' && e[1] === '1'))
    assert.ok(attempt1Events.length > 0)
    // No event in this run should ever report an id other than '1' -- only one
    // socket generation exists so far.
    for (const e of events) {
      if (e[0] === 'onOpen' || e[0] === 'onMessage') assert.equal(e[1], '1')
    }
  } finally {
    rws.close()
  }
})
