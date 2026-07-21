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
  fakeOpen() { this.readyState = 1; this.emit('open') } // OPEN
  fakeClose(code = 1000, reason = '') { this.readyState = 3; this.emit('close', code, reason) }
  fakeError(err) { this.emit('error', err) }
}
FakeWebSocket.OPEN = 1

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
    onMessage: () => {},
    onOpen: () => events.push(['onOpen']),
    onClose: (reason) => events.push(['onClose', reason]),
    onRetryScheduled: (attemptId, delayMs) => events.push(['retryScheduled', attemptId, delayMs]),
    onAttemptOpen: (attemptId) => events.push(['attemptOpen', attemptId]),
    log: () => {},
    ...overrides,
  })
  return { rws, created, events }
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

test('heartbeat-timeout and manual-reconnect reasons are distinct from close/error', () => {
  const { rws, created, events } = makeHarness({ heartbeatTimeoutMs: 10 })
  rws.connect()
  created[0].fakeOpen()
  return new Promise((resolve) => {
    setTimeout(() => {
      try {
        const closeEvents = events.filter(e => e[0] === 'onClose')
        assert.equal(closeEvents.length, 1)
        assert.equal(closeEvents[0][1], 'heartbeat-timeout')
      } finally {
        rws.close()
        resolve()
      }
    }, 30)
  })
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
