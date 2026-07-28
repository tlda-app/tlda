#!/usr/bin/env node
// A connect attempt that never opened must not tear down connection state.
//
// The daemon's onClose stops agent liveness, clears _serverReady, and runs
// teardownWatchers -- JSONL ingest, terminal watches, backing files (source
// watchers deliberately survive a disconnect; see teardownWatchers' own
// comment). Those belong to HAVING a connection. ResilientWS called
// onClose for failed connect attempts too, so a booting server -- Fly cold start
// is 90-120s against a 5s connect timeout -- produced one full teardown per
// attempt. Measured 2026-07-28: 232 of 262 daemon reconnects were
// `connection attempt timed out after 5000ms`, 34 of them inside a single boot.
//
// The number is not the defect. At any connect timeout the teardown-per-attempt
// is wrong; a larger value just makes it rarer. So the fix is the distinction,
// and this guard protects the distinction.
//
// It fails if EITHER half regresses:
//   1. ResilientWS stops reporting `established` correctly for a given lifecycle.
//   2. The daemon stops gating its teardown on it.
//
// `reason` cannot substitute for `established`: 'error' and 'close' both fire for
// a socket that died mid-handshake, which is exactly what a booting server does.
// That is why case 2 and 3 below exist.

import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'url'
import { ResilientWS } from '../shared/resilient-ws.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

class FakeWebSocket extends EventEmitter {
  constructor(url) { super(); this.url = url; this.readyState = 0 }
  send() {} close() { this.readyState = 3 } terminate() { this.readyState = 3 }
  fakeOpen() { this.readyState = 1; this.emit('open') }
  fakeClose(code = 1000) { this.readyState = 3; this.emit('close', code, '') }
  fakeError(e) { this.emit('error', e) }
}
FakeWebSocket.OPEN = 1
FakeWebSocket.CONNECTING = 0

function harness() {
  const created = []
  const closes = []
  const rws = new ResilientWS({
    url: () => 'ws://fake/',
    label: 'guard',
    initialBackoffMs: 5,
    maxBackoffMs: 10,
    connectAttemptTimeoutMs: 10,
    heartbeatTimeoutMs: 20,
    random: () => 0,
    log: () => {},
    WebSocketImpl: function (url) { const ws = new FakeWebSocket(url); created.push(ws); return ws },
    onMessage: () => {},
    onClose: (reason, attemptId, meta) => closes.push({ reason, meta }),
  })
  return { rws, created, closes }
}

const wait = (ms) => new Promise(r => setTimeout(r, ms))

// [label, drive, expectedEstablished]
const CASES = [
  ['connect attempt times out — never opened', async (h) => { h.rws.connect(); await wait(40) }, false],
  ['error during handshake — never opened', async (h) => { h.rws.connect(); h.created[0].fakeError(new Error('ECONNREFUSED')) }, false],
  ['close during handshake — never opened', async (h) => { h.rws.connect(); h.created[0].fakeClose(1006) }, false],
  ['established, then remote close', async (h) => { h.rws.connect(); h.created[0].fakeOpen(); h.created[0].fakeClose(1006) }, true],
  ['established, then heartbeat timeout', async (h) => { h.rws.connect(); h.created[0].fakeOpen(); await wait(45) }, true],
  ['established, then manual reconnect', async (h) => { h.rws.connect(); h.created[0].fakeOpen(); h.rws.reconnect() }, true],
]

for (const [label, drive, expected] of CASES) {
  const h = harness()
  await drive(h)
  h.rws.close()
  const first = h.closes[0]
  if (!first) {
    failures.push(`${label}: onClose never fired — cannot report established at all`)
    continue
  }
  const got = first.meta?.established
  if (got !== expected) {
    failures.push(
      `${label}: established=${got} (reason='${first.reason}'), expected ${expected}` +
      (expected === false
        ? ' — a never-opened attempt would tear down live connection state'
        : ' — a real connection loss would NOT tear down, which is worse than the bug')
    )
  }
}

// The consumer must gate on it. Find the daemon's onClose body and require the
// established check to precede every teardown call inside it.
const DAEMON = path.join(ROOT, 'bin/fleet-daemon.mjs')
const src = fs.readFileSync(DAEMON, 'utf8')
const start = src.indexOf('onClose: (reason, attemptId')
if (start === -1) {
  failures.push('bin/fleet-daemon.mjs: could not find the onClose handler — this guard is not looking at anything')
} else {
  const body = src.slice(start, src.indexOf('\n    },', start))
  const gateAt = body.search(/if \(!established\)\s*return/)
  const TEARDOWN = ['teardownWatchers()', 'agentLiveness.stop()', '_serverReady = false']
  if (gateAt === -1) {
    failures.push(`bin/fleet-daemon.mjs onClose: no \`if (!established) return\` — every failed connect attempt tears down again`)
  } else {
    for (const call of TEARDOWN) {
      const at = body.indexOf(call)
      if (at !== -1 && at < gateAt) {
        failures.push(`bin/fleet-daemon.mjs onClose: \`${call}\` runs BEFORE the established check — reachable from a failed connect attempt`)
      }
    }
  }
}

if (failures.length) {
  console.error('Connect-attempt teardown guard failed.\n')
  for (const f of failures) console.error(`  - ${f}`)
  console.error('\nTeardown belongs to losing an established connection. An attempt that never')
  console.error('reached OPEN holds no connection state and must not drop watchers or liveness.')
  process.exit(1)
}

console.log(`connect-attempt teardown guard: ${CASES.length} lifecycles + daemon gate OK`)
