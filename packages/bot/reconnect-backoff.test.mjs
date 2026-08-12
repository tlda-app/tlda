// The bug this file exists for: a server that is UP and REJECTING.
//
// The reconnect delay used to be reset inside ws.on('open') — i.e. on transport
// connect — one line before the login that throws. Every cycle re-opened the
// socket successfully, reset the delay to the floor, failed login, and closed,
// so the backoff could never grow. Testing Todd retried twice a second for 3.5
// hours against the daemon-route login gate on 2026-08-11.
//
// A server that is genuinely DOWN never fires 'open', so it backed off correctly
// the whole time. That case is covered here too, because the fix must not buy the
// first case by regressing the second.

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createBot, createTransportFixture } from './index.mjs'

// Captured before any patching, so waiting in the test never registers as a
// reconnect delay and never runs through the instrumented timer.
const realSetTimeout = global.setTimeout

const turn = () => new Promise(resolve => setImmediate(resolve))
const tick = () => new Promise(resolve => realSetTimeout(resolve, 1))
// A cycle spans promise jobs (login rejection, roster fallback), a close event,
// and a scheduled reconnect, so drain both microtasks and the timer phase.
const settle = async (n = 6) => { for (let i = 0; i < n; i++) { await turn(); await tick() } }

const INITIAL = 8
const MAX = 64

// Records every reconnect delay the bot schedules and fires it immediately, so a
// backoff sequence can be observed without waiting real time. Request timeouts
// (10s) are far above MAX and are left alone.
function instrumentReconnects() {
  const delays = []
  const realSetTimeout = global.setTimeout
  const realFetch = global.fetch
  global.setTimeout = (fn, ms, ...rest) => {
    if (typeof ms === 'number' && ms <= MAX) {
      delays.push(ms)
      return realSetTimeout(fn, 0, ...rest)
    }
    return realSetTimeout(fn, ms, ...rest)
  }
  // loginFleet falls back to a roster lookup when the login request rejects.
  // Keep it off the network and failing, so the login path ends in a throw.
  global.fetch = () => Promise.reject(new Error('roster unavailable in test'))
  return {
    delays,
    restore() {
      global.setTimeout = realSetTimeout
      global.fetch = realFetch
    },
  }
}

function botOptions(WebSocketClass) {
  process.env.TLDA_BOT_PIDFILE = join(mkdtempSync(join(tmpdir(), 'tlda-bot-backoff-')), 'bot.pid')
  return {
    name: 'fixture',
    fleetId: 'fleet:fixture',
    server: 'http://127.0.0.1:1',
    WebSocketClass,
    reconnectInitialMs: INITIAL,
    reconnectMaxMs: MAX,
  }
}

test('a server that is up and rejecting logins backs off', async () => {
  const { WebSocketClass, sockets } = createTransportFixture()
  const probe = instrumentReconnects()
  const bot = createBot(botOptions(WebSocketClass))
  try {
    bot.start()
    for (let cycle = 0; cycle < 5; cycle++) {
      await settle()
      const socket = sockets[cycle]
      assert.ok(socket, `expected a socket for cycle ${cycle}`)
      const request = socket.sent.find(message => message.type === 'login')
      assert.ok(request, `expected a login attempt on cycle ${cycle}`)
      // Exactly what the daemon-route gate returns. This is an error envelope,
      // not a result — `reply()` would nest it under `result` and the bot would
      // read it as a successful login with no agent.
      socket.event({ id: request.id, error: 'Agent login for "fleet:fixture" requires daemon route information.' })
      await settle()
    }
  } finally {
    bot.stop()
    probe.restore()
  }

  assert.ok(probe.delays.length >= 3, `expected several reconnects, got ${probe.delays.length}`)
  // The regression: every delay pinned at the floor because 'open' reset it.
  assert.notDeepEqual(
    probe.delays,
    probe.delays.map(() => INITIAL),
    'reconnect delay stayed at the floor while login kept failing — the reset is keyed to transport connect, not to a completed login',
  )
  assert.ok(
    probe.delays[probe.delays.length - 1] > probe.delays[0],
    `expected the delay to grow across failed logins, got ${probe.delays.join(', ')}`,
  )
  assert.ok(
    probe.delays.every(ms => ms <= MAX),
    `expected the cap to hold at ${MAX}, got ${probe.delays.join(', ')}`,
  )
})

test('a server that is down still backs off', async () => {
  // Never emits 'open' — the case the original backoff was written for.
  const sockets = []
  class DeadSocket extends EventEmitter {
    static OPEN = 1
    constructor() {
      super()
      this.readyState = 3
      this.sent = []
      sockets.push(this)
      queueMicrotask(() => {
        this.emit('error', new Error('ECONNREFUSED'))
        this.emit('close')
      })
    }
    send() {}
    close() {}
  }

  const probe = instrumentReconnects()
  const bot = createBot(botOptions(DeadSocket))
  try {
    bot.start()
    await settle(30)
  } finally {
    bot.stop()
    probe.restore()
  }

  assert.ok(probe.delays.length >= 3, `expected several reconnects, got ${probe.delays.length}`)
  assert.ok(
    probe.delays[probe.delays.length - 1] > probe.delays[0],
    `a down server must still back off, got ${probe.delays.join(', ')}`,
  )
  assert.ok(
    probe.delays.every(ms => ms <= MAX),
    `expected the cap to hold at ${MAX}, got ${probe.delays.join(', ')}`,
  )
})
