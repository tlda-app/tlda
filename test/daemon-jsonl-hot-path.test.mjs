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

// ---------- session-owner harvest (cursor owner-cache fix) ----------
import {
  extractOwnersFromText as _extractOwners,
  extractIdentityFromRecord as _extractIdentity,
  extractIdentityFromText as _extractIdentityText,
  scanFileOwnersSync as _scanOwners,
  scanFileIdentitySync as _scanIdentity,
} from '../bin/lib/daemon-jsonl-hot-path.mjs'

test('extractOwnersFromText pulls every fleet id from Registered lines, deduped', () => {
  const text = [
    'noise',
    'Registered fleet:yolo. 1244 agent(s) registered.',
    'more noise Registered fleet:791a593e — ok',
    'Registered fleet:yolo again',            // dup
    'not a match: fleet:nope without Registered',
  ].join('\n')
  assert.deepEqual(_extractOwners(text).sort(), ['fleet:791a593e', 'fleet:yolo'])
  assert.deepEqual(_extractOwners('nothing here'), [])
})

test('extractIdentityFromRecord captures fleet id, friendly name, and cwd from registration output', () => {
  const text = 'Registered fleet:abc123. Your name: "mailbox-impl".'
  assert.deepEqual(_extractIdentityText(text), {
    fleet_id: 'fleet:abc123',
    friendly_name: 'mailbox-impl',
  })
  assert.deepEqual(_extractIdentity({
    cwd: '/work/tlda',
    toolUseResult: { content: [{ type: 'text', text }] },
  }), {
    fleet_id: 'fleet:abc123',
    friendly_name: 'mailbox-impl',
    cwd: '/work/tlda',
  })
  assert.deepEqual(_extractIdentity({ payload: { cwd: '/work/other' } }), { cwd: '/work/other' })
})

test('registration capture rejects markdown/template junk and keeps real ids clean', () => {
  // A hex id and a hyphenated named id are captured verbatim.
  assert.deepEqual(_extractIdentityText('Registered fleet:32cd2551.'), { fleet_id: 'fleet:32cd2551', friendly_name: null })
  assert.deepEqual(_extractIdentityText('Registered fleet:phone-bugs and more'), { fleet_id: 'fleet:phone-bugs', friendly_name: null })
  // A doc/template line echoing the placeholder must NOT become an identity.
  assert.equal(_extractIdentityText('Usage: Registered `fleet:<id>` here'), null)
  assert.deepEqual(_extractOwners('Usage: Registered `fleet:<id>` here'), [])
  // A stray trailing backtick is dropped, not stored as part of the id.
  assert.deepEqual(_extractIdentityText('quote: Registered fleet:reconA` end'), { fleet_id: 'fleet:reconA', friendly_name: null })
  assert.deepEqual(_extractOwners('quote: Registered fleet:reconA` end'), ['fleet:reconA'])
})

test('scanFileOwnersSync harvests owners chunked (marker split across chunk boundary) + returns EOF offset', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-owner-scan-'))
  const file = path.join(dir, 'session.jsonl')
  const originalReadFileSync = fs.readFileSync
  try {
    // Put the marker so it straddles the 64KB chunk boundary.
    const prefix = 'x'.repeat(64 * 1024 - 10)
    const body = prefix + 'Registered fleet:abc123\n' + 'y'.repeat(1000) + 'Registered fleet:def456\n'
    fs.writeFileSync(file, body)
    fs.readFileSync = () => { throw new Error('owner scan must be chunked, not readFileSync') }
    const { owners, endOffset } = _scanOwners(file)
    assert.deepEqual(owners.sort(), ['fleet:abc123', 'fleet:def456'])
    assert.equal(endOffset, Buffer.byteLength(body))
  } finally {
    fs.readFileSync = originalReadFileSync
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('scanFileOwnersSync from a byte offset only scans the tail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-owner-tail-'))
  const file = path.join(dir, 'session.jsonl')
  try {
    const head = 'Registered fleet:old\n'
    const tail = 'Registered fleet:new\n'
    fs.writeFileSync(file, head + tail)
    const { owners } = _scanOwners(file, { fromOffset: Buffer.byteLength(head) })
    assert.deepEqual(owners, ['fleet:new'])  // old owner (before offset) not re-harvested
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('scanFileIdentitySync harvests identity and cwd without whole-file read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-identity-scan-'))
  const file = path.join(dir, 'session.jsonl')
  const originalReadFileSync = fs.readFileSync
  try {
    const record = {
      cwd: '/repo',
      toolUseResult: { content: [{ type: 'text', text: 'Registered fleet:abc123. Your name: "daemon-impl".' }] },
    }
    fs.writeFileSync(file, 'x'.repeat(64 * 1024 - 20) + '\n' + JSON.stringify(record) + '\n')
    fs.readFileSync = () => { throw new Error('identity scan must be chunked, not readFileSync') }
    const { identity, owners, endOffset } = _scanIdentity(file)
    assert.deepEqual(identity, {
      fleet_id: 'fleet:abc123',
      friendly_name: 'daemon-impl',
      cwd: '/repo',
    })
    assert.deepEqual(owners, ['fleet:abc123'])
    assert.equal(endOffset, fs.statSync(file).size)
  } finally {
    fs.readFileSync = originalReadFileSync
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

import { decideSessionBackfill as _decide } from '../bin/lib/daemon-jsonl-hot-path.mjs'

test('decideSessionBackfill classifies once — a classified session is NOT re-scanned on later spawns', () => {
  // Simulate the daemon's cursor entry for one session file.
  let entry = undefined
  let scans = 0
  const scan = () => { scans++; return { owners: ['fleet:alice'] } }

  // First spawn (agent bob): unclassified → scans once, learns owner=alice, not bob's.
  const d1 = _decide(entry, 'fleet:bob', scan)
  assert.equal(d1.didScan, true)
  assert.equal(d1.shouldBackfill, false)          // alice's file, not bob's
  entry = { classified: true, owners: d1.owners }  // daemon caches it

  // Second spawn (agent carol): classified → MUST NOT scan again.
  const d2 = _decide(entry, 'fleet:carol', scan)
  assert.equal(d2.didScan, false)                  // ← the fix: zero I/O
  assert.equal(d2.shouldBackfill, false)
  assert.equal(scans, 1)                            // still only ever scanned once

  // Third spawn (the actual owner, alice): still cache — backfill yes, still no re-scan.
  const d3 = _decide(entry, 'fleet:alice', scan)
  assert.equal(d3.didScan, false)
  assert.equal(d3.shouldBackfill, true)
  assert.equal(scans, 1)
})

test('decideSessionBackfill skips already search-backfilled sessions with no scan', () => {
  let scans = 0
  const d = _decide({ searchBackfilled: true, owners: ['fleet:x'] }, 'fleet:x', () => { scans++; return { owners: [] } })
  assert.equal(d.didScan, false)
  assert.equal(d.shouldBackfill, false)  // already indexed → nothing to do
  assert.equal(scans, 0)
})

import { readFirstLineSync as _firstLine } from '../bin/lib/daemon-jsonl-hot-path.mjs'

test('readFirstLineSync reads ONLY the first line, never the whole (multi-MB) file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-firstline-'))
  const file = path.join(dir, 'rollout.jsonl')
  const originalReadFileSync = fs.readFileSync
  try {
    const firstLine = JSON.stringify({ payload: { id: 'abc-123', cwd: '/x' } })
    fs.writeFileSync(file, firstLine + '\n' + 'y'.repeat(4 * 1024 * 1024)) // 4MB tail
    fs.readFileSync = () => { throw new Error('must not readFileSync the whole rollout') }
    assert.equal(_firstLine(file), firstLine)
    // sanity: it parses to the codex id
    assert.equal(JSON.parse(_firstLine(file)).payload.id, 'abc-123')
  } finally {
    fs.readFileSync = originalReadFileSync
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
