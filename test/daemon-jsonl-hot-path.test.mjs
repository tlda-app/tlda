import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  createJsonlReadCoalescer,
  createOncePerKeyGate,
  fileContainsUtf8MarkerSync,
} from '../bin/lib/daemon-jsonl-hot-path.mjs'

function fakeTimers() {
  let nextId = 1
  const timers = new Map()
  return {
    set(fn, ms) {
      const id = nextId++
      timers.set(id, { fn, ms })
      return id
    },
    clear(id) {
      timers.delete(id)
    },
    runLast() {
      const last = [...timers.entries()].at(-1)
      assert.ok(last, 'expected a pending timer')
      timers.delete(last[0])
      last[1].fn()
      return last[1].ms
    },
    count() {
      return timers.size
    },
  }
}

test('JSONL read coalescer collapses repeated poll ticks for the same file', () => {
  let now = 1000
  const timers = fakeTimers()
  const calls = []
  const coalescer = createJsonlReadCoalescer({
    readNow: (...args) => calls.push(args),
    now: () => now,
    setTimer: timers.set,
    clearTimer: timers.clear,
    delayMs: 100,
    maxDelayMs: 300,
  })

  coalescer.schedule('/tmp/a.jsonl', 'agent-a', '/tmp/a.jsonl', 'session-a', 'claude')
  now += 25
  coalescer.schedule('/tmp/a.jsonl', 'agent-a', '/tmp/a.jsonl', 'session-a', 'claude')
  now += 25
  coalescer.schedule('/tmp/a.jsonl', 'agent-b', '/tmp/a.jsonl', 'session-a', 'claude')

  assert.equal(calls.length, 0)
  assert.equal(coalescer.pendingCount(), 1)
  assert.equal(timers.count(), 1)

  timers.runLast()
  assert.deepEqual(calls, [['agent-b', '/tmp/a.jsonl', 'session-a', 'claude']])
  assert.equal(coalescer.pendingCount(), 0)
})

test('JSONL read coalescer enforces a max wait under continuous load', () => {
  let now = 0
  const timers = fakeTimers()
  const calls = []
  const coalescer = createJsonlReadCoalescer({
    readNow: (...args) => calls.push(args),
    now: () => now,
    setTimer: timers.set,
    clearTimer: timers.clear,
    delayMs: 100,
    maxDelayMs: 250,
  })

  coalescer.schedule('/tmp/a.jsonl', 'agent-a', '/tmp/a.jsonl', 'session-a', 'claude')
  now = 260
  coalescer.schedule('/tmp/a.jsonl', 'agent-a', '/tmp/a.jsonl', 'session-a', 'claude')

  assert.deepEqual(calls, [['agent-a', '/tmp/a.jsonl', 'session-a', 'claude']])
  assert.equal(coalescer.pendingCount(), 0)
})

test('once-per-key gate prevents repeated steady-state backfill sweeps', () => {
  const gate = createOncePerKeyGate()
  assert.equal(gate.claim('fleet:agent-a'), true)
  assert.equal(gate.claim('fleet:agent-a'), false)
  assert.equal(gate.claim('fleet:agent-b'), true)
})

test('marker scan is byte-chunked and does not use full-file readFileSync', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-jsonl-marker-'))
  const file = path.join(dir, 'session.jsonl')
  const originalReadFileSync = fs.readFileSync
  try {
    const prefix = 'x'.repeat(64 * 1024 - 10)
    fs.writeFileSync(file, prefix + 'Registered fleet:abc123\n' + 'y'.repeat(64 * 1024))
    fs.readFileSync = () => {
      throw new Error('readFileSync should not be used by marker scan')
    }

    assert.equal(fileContainsUtf8MarkerSync(file, 'Registered fleet:abc123'), true)
    assert.equal(fileContainsUtf8MarkerSync(file, 'Registered fleet:missing'), false)
  } finally {
    fs.readFileSync = originalReadFileSync
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
