import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeActivityThrottle } from '../bin/lib/activity-throttle.mjs'

// Fake clock + timer queue so we can assert exact timing with no real waits.
function harness(windowMs = 2000) {
  let t = 1_000_000            // arbitrary non-zero start
  let nextId = 1
  const pending = new Map()    // id -> { fireAt, fn }
  const sent = []              // { agentId, evt, at }

  const throttle = makeActivityThrottle({
    windowMs,
    now: () => t,
    setTimer: (fn, ms) => { const id = nextId++; pending.set(id, { fireAt: t + ms, fn }); return id },
    clearTimer: (id) => { pending.delete(id) },
    send: (agentId, evt) => sent.push({ agentId, evt, at: t }),
  })

  function advance(ms) {
    const target = t + ms
    // Fire due timers in chronological order as the clock moves forward.
    while (true) {
      let next = null
      for (const [id, e] of pending) {
        if (e.fireAt <= target && (!next || e.fireAt < next.fireAt)) next = { id, ...e }
      }
      if (!next) break
      t = next.fireAt
      pending.delete(next.id)
      next.fn()
    }
    t = target
  }

  const ev = (tool) => ({ tool, ts: new Date(t).toISOString() })
  return { throttle, sent, advance, ev, now: () => t }
}

test('leading edge: first event after idle flushes immediately (no wait)', () => {
  const h = harness()
  const t0 = h.now()
  h.throttle.buffer('a', [h.ev('Bash')])
  // Sent synchronously, at the same instant — zero added latency.
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].agentId, 'a')
  assert.equal(h.sent[0].at, t0)
})

test('burst within window: batched into one trailing flush at the window boundary', () => {
  const h = harness(2000)
  const t0 = h.now()
  h.throttle.buffer('a', [h.ev('Bash')])        // leading edge → sent now
  assert.equal(h.sent.length, 1)

  h.advance(500); h.throttle.buffer('a', [h.ev('Read')])   // inside window → buffered
  h.advance(500); h.throttle.buffer('a', [h.ev('Edit')])   // inside window → buffered
  assert.equal(h.sent.length, 1, 'no extra push mid-window')

  // The trailing flush fires exactly at t0 + windowMs, carrying both buffered events.
  h.advance(1000)
  assert.equal(h.sent.length, 3)
  assert.deepEqual(h.sent.slice(1).map(s => s.evt.tool), ['Read', 'Edit'])
  assert.equal(h.sent[1].at, t0 + 2000)
  assert.equal(h.sent[2].at, t0 + 2000)
})

test('rate bound preserved: a chatty agent pushes at most once per window after the leading edge', () => {
  const h = harness(2000)
  const t0 = h.now()
  // 100ms apart for 6s → leading edge + one flush per 2s window.
  for (let i = 0; i < 60; i++) { h.throttle.buffer('a', [h.ev(`t${i}`)]); h.advance(100) }
  h.advance(2000) // let any final trailing flush fire
  // Flush events occur at distinct timestamps; count them.
  const flushTimes = [...new Set(h.sent.map(s => s.at))]
  // Over ~8s with a 2s window: leading edge + ~3-4 boundary flushes — never one-per-event.
  assert.ok(flushTimes.length <= 5, `expected <=5 flushes, got ${flushTimes.length}`)
  // Nothing dropped: every buffered event was sent exactly once.
  assert.equal(h.sent.length, 60)
})

test('per-agent independence: B flushes immediately even though A just flushed', () => {
  const h = harness(2000)
  h.throttle.buffer('a', [h.ev('Bash')])  // A leading edge
  h.advance(300)
  const tB = h.now()
  h.throttle.buffer('b', [h.ev('Bash')])  // B is fresh → must flush immediately, not wait for A's window
  const bSends = h.sent.filter(s => s.agentId === 'b')
  assert.equal(bSends.length, 1)
  assert.equal(bSends[0].at, tB, 'agent B not penalized by agent A activity')
})

test('idle gap re-arms the leading edge', () => {
  const h = harness(2000)
  h.throttle.buffer('a', [h.ev('one')])   // leading edge at t0
  assert.equal(h.sent.length, 1)
  h.advance(5000)                          // long idle (> window)
  const t1 = h.now()
  h.throttle.buffer('a', [h.ev('two')])    // quiet again → immediate
  assert.equal(h.sent.length, 2)
  assert.equal(h.sent[1].at, t1)
})
