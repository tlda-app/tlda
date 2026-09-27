// Freshness annotation for the trusted-idle map: the idle figure plus the age
// of the input it rests on, per agent, and a daemon-pipe canary for the map.
// A touch age of null means the idle rests on the aliveSince fallback — no
// touch has been processed for that agent this server run. The canary answers
// "how long since any daemon-pipe signal was processed"; under a delivery
// stall it grows while idles go stale, which is the signature the 21:10:31Z
// hibernate of a working agent showed (idle 1204, no touch, stalled pipe).
// The server never withholds the map when stale; consumers decide.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { annotateIdleFreshness } from './trusted-idle-freshness.mjs'

const NOW = Date.parse('2026-09-27T21:10:31.000Z')

test('idle map passes through untouched', () => {
  const idle = { 'fleet:a': 1204, 'fleet:b': 12 }
  const out = annotateIdleFreshness({
    idleSecondsByAgent: idle,
    touchAtMsByAgent: {},
    daemonPipeTouchAtMs: NOW,
    nowMs: NOW,
  })
  assert.deepEqual(out.idleSecondsByAgent, idle)
})

test('touch ages are floored seconds, null touch stays null', () => {
  const out = annotateIdleFreshness({
    idleSecondsByAgent: { 'fleet:a': 45, 'fleet:b': 1204 },
    touchAtMsByAgent: { 'fleet:a': NOW - 45_678, 'fleet:b': null },
    daemonPipeTouchAtMs: NOW - 3_000,
    nowMs: NOW,
  })
  assert.deepEqual(out.touchAgeSecondsByAgent, { 'fleet:a': 45, 'fleet:b': null })
})

test('daemon-pipe canary is floored, null when nothing processed this run', () => {
  const fresh = annotateIdleFreshness({
    idleSecondsByAgent: {},
    touchAtMsByAgent: {},
    daemonPipeTouchAtMs: NOW - 92_500,
    nowMs: NOW,
  })
  assert.equal(fresh.freshness.daemonPipeTouchAgeSecs, 92)
  const cold = annotateIdleFreshness({
    idleSecondsByAgent: {},
    touchAtMsByAgent: {},
    daemonPipeTouchAtMs: null,
    nowMs: NOW,
  })
  assert.equal(cold.freshness.daemonPipeTouchAgeSecs, null)
})

test('computedAt echoes nowMs as ISO', () => {
  const out = annotateIdleFreshness({ nowMs: NOW })
  assert.equal(out.freshness.computedAt, '2026-09-27T21:10:31.000Z')
})

test('future timestamps clamp to zero, never negative', () => {
  const out = annotateIdleFreshness({
    idleSecondsByAgent: { 'fleet:a': 0 },
    touchAtMsByAgent: { 'fleet:a': NOW + 5_000 },
    daemonPipeTouchAtMs: NOW + 60_000,
    nowMs: NOW,
  })
  assert.equal(out.touchAgeSecondsByAgent['fleet:a'], 0)
  assert.equal(out.freshness.daemonPipeTouchAgeSecs, 0)
})

test('incident shape: high idle on no touch with a quiet pipe stays visible', () => {
  const out = annotateIdleFreshness({
    idleSecondsByAgent: { 'fleet:a2414eaf': 1204 },
    touchAtMsByAgent: { 'fleet:a2414eaf': null },
    daemonPipeTouchAtMs: NOW - 90_000,
    nowMs: NOW,
  })
  assert.deepEqual(out, {
    idleSecondsByAgent: { 'fleet:a2414eaf': 1204 },
    touchAgeSecondsByAgent: { 'fleet:a2414eaf': null },
    freshness: {
      computedAt: '2026-09-27T21:10:31.000Z',
      daemonPipeTouchAgeSecs: 90,
    },
  })
})

test('defaults tolerate missing inputs', () => {
  const out = annotateIdleFreshness()
  assert.deepEqual(out.idleSecondsByAgent, {})
  assert.deepEqual(out.touchAgeSecondsByAgent, {})
  assert.equal(typeof out.freshness.computedAt, 'string')
  assert.equal(out.freshness.daemonPipeTouchAgeSecs, null)
})
