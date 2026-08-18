#!/usr/bin/env node
// The trace store's trim() runs on every append. It must still evict correctly,
// and it must not do the eviction sweep when nothing is over a bound.
//
// Before 2026-08-17 it did the full sweep unconditionally: a Set rebuilt from
// every retained event plus a walk of every trace key, per traced event. With
// 26 call sites on the mint, chat, daemon-frame and source-op paths, that is
// roughly 2500 allocations per control-plane event to discover there was
// nothing to do.
//
// The risk in guarding it is that eviction silently stops, which no existing
// test covered — there were none for this module at all. These assert the
// boundary in both directions: at the bound nothing is dropped, one past it the
// oldest goes, and a trace with no surviving events is not left behind.
//
// Asserted through `snapshot()`, which reports `retained_events` and
// `retained_traces` directly. A first draft of this file used `recent()` — which
// returns TRACES, takes a positional number, and was being handed an object, so
// it silently fell back to its default and the event assertions were checking
// `.operation` on trace objects that have no such field. Vacuously true. The
// counts below are the store's own.
import assert from 'node:assert/strict'
import { createControlPlaneTraceStore } from '../server/lib/observability/control-plane-trace.mjs'

let failures = 0
const check = (label, fn) => {
  try {
    fn()
    console.log(`  ok   ${label}`)
  } catch (e) {
    failures++
    console.error(`  FAIL ${label}: ${e.message}`)
  }
}

const ev = (store, traceId, i) => store.append({
  trace_id: traceId,
  ts: new Date(1786900000000 + i * 1000).toISOString(),
  operation: `op-${i}`,
})

check('under the bound, everything is retained', () => {
  const store = createControlPlaneTraceStore({ maxEvents: 5, maxTraces: 5 })
  for (let i = 0; i < 4; i++) ev(store, `t-${i}`, i)
  const snap = store.snapshot()
  assert.equal(snap.retained_events, 4)
  assert.equal(snap.retained_traces, 4)
})

check('exactly at the bound, nothing is dropped', () => {
  const store = createControlPlaneTraceStore({ maxEvents: 5, maxTraces: 5 })
  for (let i = 0; i < 5; i++) ev(store, `t-${i}`, i)
  assert.equal(store.snapshot().retained_events, 5)
  assert.ok(store.get('t-0'), 'the oldest trace is still present at the bound')
})

check('one past the bound, the oldest event goes', () => {
  const store = createControlPlaneTraceStore({ maxEvents: 5, maxTraces: 50 })
  for (let i = 0; i < 6; i++) ev(store, `t-${i}`, i)
  assert.equal(store.snapshot().retained_events, 5, 'must not exceed maxEvents')
  const ops = [...Array(6).keys()].flatMap(i => (store.get(`t-${i}`)?.events || []).map(e => e.operation))
  assert.ok(!ops.includes('op-0'), 'the oldest event must be evicted')
  assert.ok(ops.includes('op-5'), 'the newest event must survive')
})

check('a trace with no surviving events is dropped with them', () => {
  const store = createControlPlaneTraceStore({ maxEvents: 5, maxTraces: 50 })
  for (let i = 0; i < 6; i++) ev(store, `t-${i}`, i)
  assert.equal(store.get('t-0'), null, 'trace whose only event was evicted must not be retained')
  assert.ok(store.get('t-5'), 'a live trace survives')
})

check('maxTraces is still enforced', () => {
  const store = createControlPlaneTraceStore({ maxEvents: 1000, maxTraces: 3 })
  for (let i = 0; i < 6; i++) ev(store, `t-${i}`, i)
  const kept = [0, 1, 2, 3, 4, 5].filter(i => store.get(`t-${i}`))
  assert.ok(kept.length <= 3, `expected at most 3 traces, kept ${kept.length}`)
  assert.ok(store.get('t-5'), 'the newest trace must survive')
})

check('many appends well under the bound stay correct', () => {
  const store = createControlPlaneTraceStore({ maxEvents: 2000, maxTraces: 500 })
  for (let i = 0; i < 300; i++) ev(store, 'one-trace', i)
  assert.equal(store.snapshot().retained_events, 300)
  assert.equal(store.snapshot().retained_traces, 1)
  assert.equal(store.get('one-trace').events.length, 300)
})

console.log(failures === 0 ? 'PASS control-plane trace trim' : `FAIL control-plane trace trim (${failures})`)
process.exit(failures === 0 ? 0 : 1)
