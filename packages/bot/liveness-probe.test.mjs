// The bug this file exists for: a bot that receives and never sends cannot
// discover that its socket has stopped working.
//
// The reconnect path recognises a close, an error, or a send failure. On
// 2026-08-17 the testing server stopped answering while every bot's TCP socket
// stayed ESTABLISHED, so none of those three ever fired: `onClose` never ran,
// `onOpen` never ran, `loginFleet` never re-ran, and the `subscribe-filter` was
// never re-sent. todd, debt and grammar each sat holding a live socket with no
// subscription until a human killed the process. chat-lint sat in the same shape
// for six days.
//
// The fix may not be a silence timer that closes the socket — `e04564cbb`
// removed exactly that on purpose. So the bot asks a question instead, and
// reconnects only when the socket demonstrably cannot carry a round trip.

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createBot, createTransportFixture } from './index.mjs'

const FLEET_ID = 'fleet:probe-test'
const KEY = 'probetestbot'

const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms))
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await tick(2) }

function pidFile() {
  return join(mkdtempSync(join(tmpdir(), 'bot-probe-')), 'bot.pid')
}

// Drive the socket far enough that the bot is logged in and canonical, so the
// only thing left unanswered is the probe itself.
async function completeLogin(socket) {
  for (let i = 0; i < 40 && !socket.sent.some(m => m.type === 'login'); i++) await tick(2)
  const login = socket.sent.find(m => m.type === 'login')
  assert.ok(login, 'bot should attempt login')
  socket.reply(login, { ok: true, agent: { id: FLEET_ID, friendly_name: KEY } })
  for (let i = 0; i < 40 && !socket.sent.some(m => m.type === 'subscribe-filter'); i++) await tick(2)
  const sub = socket.sent.find(m => m.type === 'subscribe-filter')
  if (sub) socket.reply(sub, { ok: true })
  await settle()
}

function startBot({ WebSocketClass, livenessProbeIntervalMs }) {
  return createBot({
    name: KEY,
    fleetId: FLEET_ID,
    server: 'http://fixture.invalid',
    pidFile: pidFile(),
    WebSocketClass,
    livenessProbeIntervalMs,
    livenessProbeTimeoutMs: 10,
    // Default backoff is 500ms; the waits below are in tens of milliseconds.
    reconnectInitialMs: 5,
    reconnectMaxMs: 20,
  })
}

test('an unanswered probe reconnects a socket that is still open', async () => {
  const { WebSocketClass, sockets } = createTransportFixture()
  const bot = startBot({ WebSocketClass, livenessProbeIntervalMs: 15 })
  try {
    bot.start()
    await settle()
    assert.equal(sockets.length, 1, 'one socket after connect')

    await completeLogin(sockets[0])

    // The probe goes out and is never answered. The socket is never closed by the
    // peer and never errors — the exact shape of 2026-08-17.
    for (let i = 0; i < 60 && !sockets[0].sent.some(m => m.type === 'heartbeat'); i++) await tick(5)
    assert.ok(sockets[0].sent.some(m => m.type === 'heartbeat'), 'bot should probe with a heartbeat round trip')

    for (let i = 0; i < 60 && sockets.length < 2; i++) await tick(5)
    assert.ok(sockets.length >= 2, 'an unanswered probe should reconnect')
  } finally {
    bot.stop()
  }
})

// The counterfactual. Without the probe this is precisely the stuck state: the
// socket stays open, nothing is ever sent, and no reconnect is ever scheduled.
test('with the probe disabled, a silent socket is never reconnected', async () => {
  const { WebSocketClass, sockets } = createTransportFixture()
  const bot = startBot({ WebSocketClass, livenessProbeIntervalMs: 0 })
  try {
    bot.start()
    await settle()
    await completeLogin(sockets[0])

    for (let i = 0; i < 40; i++) await tick(5)
    assert.equal(sockets.length, 1, 'no probe means no evidence, so no reconnect')
    assert.ok(!sockets[0].sent.some(m => m.type === 'heartbeat'), 'no probe should be sent when disabled')
  } finally {
    bot.stop()
  }
})
