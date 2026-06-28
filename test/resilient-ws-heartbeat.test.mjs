#!/usr/bin/env node
// Tests for ResilientWS's heartbeat watchdog (shared/resilient-ws.mjs).
//
// The watchdog (heartbeatTimeoutMs) detects a half-open/zombie connection that
// stays readyState===OPEN after the peer is gone. It resets on ANY liveness
// evidence — an application message OR a protocol-level ping — and if neither
// arrives within the timeout it closes + reconnects. These tests pin all three
// behaviors against a real local WebSocket server.

import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocketServer } from 'ws'

import { ResilientWS } from '../shared/resilient-ws.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Spin up a ws server on an ephemeral port; resolve once it's listening.
function startServer(onConnection) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 })
    wss.on('connection', (ws) => onConnection(ws))
    wss.on('listening', () => resolve({ wss, port: wss.address().port }))
  })
}

function closeServer(wss) {
  return new Promise((resolve) => wss.close(resolve))
}

test('watchdog fires on total silence → reconnects', async () => {
  let connections = 0
  // Server accepts the socket but sends nothing and never pings — a stand-in
  // for a peer that has silently gone away while the socket still reads OPEN.
  const { wss, port } = await startServer(() => { connections++ })

  const rws = new ResilientWS({
    url: () => `ws://127.0.0.1:${port}`,
    label: 'test-silent',
    heartbeatTimeoutMs: 150,
    initialBackoffMs: 30,
    maxBackoffMs: 30,
    onMessage: () => {},
    log: () => {},
  })
  rws.connect()

  // 1st connect → 150ms silence → watchdog closes → ~30ms backoff → reconnect.
  await sleep(450)
  rws.close()
  await closeServer(wss)

  assert.ok(connections >= 2, `expected ≥2 connections from watchdog reconnects, got ${connections}`)
})

test('protocol ping resets the watchdog → no reconnect', async () => {
  let connections = 0
  // Server pings every 60ms — well under the 150ms timeout. The ping must keep
  // the watchdog from firing even though no application message is ever sent.
  const { wss, port } = await startServer((ws) => {
    connections++
    const t = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping() }, 60)
    ws.on('close', () => clearInterval(t))
  })

  const rws = new ResilientWS({
    url: () => `ws://127.0.0.1:${port}`,
    label: 'test-ping',
    heartbeatTimeoutMs: 150,
    initialBackoffMs: 30,
    maxBackoffMs: 30,
    onMessage: () => {},
    log: () => {},
  })
  rws.connect()

  await sleep(500)
  rws.close()
  await closeServer(wss)

  assert.equal(connections, 1, `ping should prevent reconnect; got ${connections} connections`)
})

test('application message resets the watchdog → no reconnect', async () => {
  let connections = 0
  const { wss, port } = await startServer((ws) => {
    connections++
    const t = setInterval(() => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'tick' })) }, 60)
    ws.on('close', () => clearInterval(t))
  })

  const rws = new ResilientWS({
    url: () => `ws://127.0.0.1:${port}`,
    label: 'test-message',
    heartbeatTimeoutMs: 150,
    initialBackoffMs: 30,
    maxBackoffMs: 30,
    onMessage: () => {},
    log: () => {},
  })
  rws.connect()

  await sleep(500)
  rws.close()
  await closeServer(wss)

  assert.equal(connections, 1, `messages should prevent reconnect; got ${connections} connections`)
})

test('heartbeatTimeoutMs unset (0) → watchdog disabled, never reconnects on silence', async () => {
  let connections = 0
  // Regression guard: existing consumers that pass no heartbeatTimeoutMs must
  // keep the old behavior — a silent-but-open socket is NOT torn down.
  const { wss, port } = await startServer(() => { connections++ })

  const rws = new ResilientWS({
    url: () => `ws://127.0.0.1:${port}`,
    label: 'test-disabled',
    initialBackoffMs: 30,
    maxBackoffMs: 30,
    onMessage: () => {},
    log: () => {},
  })
  rws.connect()

  await sleep(400)
  rws.close()
  await closeServer(wss)

  assert.equal(connections, 1, `disabled watchdog should not reconnect; got ${connections} connections`)
})
