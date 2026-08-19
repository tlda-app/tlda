// A socket that is open and silent is the failure nobody could see.
//
// When a deploy replaces the machine without a clean close, the browser's fleet
// socket stays in readyState 1: no close event, no error, no data, and the
// reconnect path is never entered. The composer keeps working and no message
// ever arrives again. Skip has been reporting this as the app being broken;
// there was nothing to see because nothing errored.
//
// Measured on his own session from client.log telemetry, filtering to samples
// where the client believed it was connected: 440 over 60s of inbound silence,
// 295 over two minutes, 93 over five, worst 10m25s. The worst episode shows as
// a ramp -- 584s, 594s, 604s, 614s, 624s -- the 10s heartbeat firing into
// nothing while `connected: true` held throughout.
//
// The heartbeat already existed. Its reply was never checked, _lastWsActivityAt
// was recorded and read by nothing but telemetry, and the comment said
// "destructive recovery is left to real close/error paths" -- which, when the
// close never comes, means nothing happens.
import test from 'node:test'
import assert from 'node:assert/strict'

import { shouldForceReconnectForSilence } from '../src/fleet/ws-liveness.mjs'

const OPEN = 1
const CONNECTING = 0
const CLOSING = 2
const CLOSED = 3
const THRESHOLD = 45_000
const NOW = 1_800_000_000_000

const check = over => shouldForceReconnectForSilence({
  readyState: OPEN,
  lastActivityAt: NOW - over,
  now: NOW,
  thresholdMs: THRESHOLD,
})

test('an open socket silent past the threshold is forced to reconnect', () => {
  assert.equal(check(THRESHOLD + 1), true)
})

test('his worst measured episode would have been caught in the first 45 seconds', () => {
  // 10m25s is what actually happened. Every one of these is past the threshold,
  // so the watchdog fires long before any of them are reached.
  for (const silentMs of [60_000, 120_000, 300_000, 624_611]) {
    assert.equal(check(silentMs), true, `${silentMs}ms of silence must force a reconnect`)
  }
})

test('normal traffic never trips it', () => {
  // Healthy inbound gaps on that session ran under ~20s. These must all be
  // quiet: a watchdog that fires on ordinary jitter costs a resubscribe every
  // time and would be worse than the bug.
  for (const silentMs of [0, 17, 1_937, 8_346, 18_346, 30_000, THRESHOLD]) {
    assert.equal(check(silentMs), false, `${silentMs}ms of silence is normal`)
  }
})

test('only an OPEN socket can be silently dead', () => {
  // CONNECTING belongs to the never-opened watchdog; CLOSING and CLOSED already
  // have paths that handle them. Acting here would be a second reconnect route.
  for (const readyState of [CONNECTING, CLOSING, CLOSED, null]) {
    assert.equal(shouldForceReconnectForSilence({
      readyState, lastActivityAt: NOW - 10 * THRESHOLD, now: NOW, thresholdMs: THRESHOLD,
    }), false, `readyState ${readyState} is not ours to reconnect`)
  }
})

test('a socket that has never heard anything is not judged', () => {
  // lastActivityAt is stamped on open. Zero means we are not in a position to
  // judge, and treating it as silence since the epoch would force a reconnect
  // the first time the timer ran -- an instant reconnect loop on every load.
  assert.equal(shouldForceReconnectForSilence({
    readyState: OPEN, lastActivityAt: 0, now: NOW, thresholdMs: THRESHOLD,
  }), false)
})

test('a missing or nonsense threshold disables the watchdog rather than tripping it', () => {
  for (const thresholdMs of [0, -1, NaN, undefined]) {
    assert.equal(shouldForceReconnectForSilence({
      readyState: OPEN, lastActivityAt: NOW - 10 * THRESHOLD, now: NOW, thresholdMs,
    }), false, `threshold ${thresholdMs} must not force a reconnect`)
  }
})
