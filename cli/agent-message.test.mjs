import test from 'node:test'
import assert from 'node:assert/strict'

import { messageLocalAgent } from './tlda.mjs'

// Pins the TYPE-AND-SUBMIT CONNECTION in messageLocalAgent, not just a
// helper: tmux is scripted (list-panes / capture-pane / send-keys) and every
// case asserts on the calls the function actually made — what it typed,
// how many Enters it sent, and whether it consulted the pane at all.

function makeAgent(kind = 'muse') {
  return {
    friendlyName: 'probe-agent',
    fleetId: 'fleet:probe',
    mintId: 'mint-probe',
    launchRecipe: { kind },
    processState: { tmux_session: 'fleet-probe' },
  }
}

function makeWorld({ agent, captures }) {
  const calls = []
  const logs = []
  let ci = 0
  const spawnSync = (cmd, args) => {
    const flat = [cmd, ...args].join(' ')
    calls.push(flat)
    if (args.includes('list-panes')) return { status: 0, stdout: '%99\n', stderr: '' }
    if (args.includes('capture-pane')) {
      return { status: 0, stdout: captures[Math.min(ci++, captures.length - 1)], stderr: '' }
    }
    return { status: 0, stdout: '', stderr: '' }
  }
  const exits = []
  const lockEvents = []
  return {
    calls,
    logs,
    exits,
    lockEvents,
    opts: {
      spawnSyncImpl: spawnSync,
      openLedger: () => ({ resolve: () => agent, close() {} }),
      exitImpl: code => { exits.push(code) },
      log: { log: m => logs.push(`log:${m}`), error: m => logs.push(`error:${m}`) },
      enqueueHistory: async () => 'qid-1',
      withPaneLock: async (session, fn) => {
        lockEvents.push(`lock:${session}`)
        try {
          return await fn()
        } finally {
          lockEvents.push(`unlock:${session}`)
        }
      },
    },
  }
}

const enters = calls => calls.filter(c => /(?:^| )Enter$/.test(c)).length
const types = calls => calls.filter(c => c.includes(' -l ')).length
const captures = calls => calls.filter(c => c.includes('capture-pane')).length

test('a lost Enter is retried and the pane is consulted, all under one lock', async () => {
  // The measured muse failure: text sits in compose past observation windows,
  // so more Enters follow. Polls-per-window varies with real timing, so the
  // retry count is asserted as a range, not an exact number.
  const STILL = 'transcript\n❯ 💬 hello\nstatus'
  const w = makeWorld({
    agent: makeAgent('muse'),
    captures: [
      'transcript\n❯\nstatus',
      'transcript\n❯ 💬 hello\nstatus',
      ...Array.from({ length: 25 }, () => STILL),
      'transcript\n❯ 💬 hello\n◆ Working (1s)\n❯\nstatus',
    ],
  })
  const r = await messageLocalAgent('probe-agent', 'hello', w.opts)
  assert.equal(r.ok, true)
  assert.equal(w.exits[0], 0)
  assert.equal(types(w.calls), 1, 'types exactly once — retyping would duplicate')
  const nEnters = enters(w.calls)
  assert.ok(nEnters >= 2 && nEnters <= 3, `retries a lost Enter, bounded (got ${nEnters})`)
  assert.ok(captures(w.calls) > 0, 'declares nothing without reading the pane')
  assert.deepEqual(w.lockEvents, ['lock:fleet-probe', 'unlock:fleet-probe'])
  assert.ok(w.logs.some(l => l.includes('submitted')), 'success line says submitted')
  assert.ok(!w.logs.some(l => l.includes('Delivered')), 'reserved word stays out')
})

test('text that never lands is never submitted blindly', async () => {
  const w = makeWorld({
    agent: makeAgent('muse'),
    captures: ['transcript\n❯\nstatus'],
  })
  const r = await messageLocalAgent('probe-agent', 'hello', w.opts)
  assert.equal(r.ok, false)
  assert.equal(r.error, 'type-not-accepted')
  assert.equal(enters(w.calls), 0, 'no blind Enter')
  assert.equal(w.exits[0], 1)
})

test('an unknown harness is refused before touching tmux', async () => {
  const w = makeWorld({ agent: makeAgent('codex'), captures: [] })
  const r = await messageLocalAgent('probe-agent', 'hello', w.opts)
  assert.equal(r.ok, false)
  assert.equal(r.error, 'unsupported-harness')
  assert.equal(w.calls.length, 0, 'not even a pane lookup')
  assert.equal(w.exits[0], 1)
})

test("someone else's compose text aborts instead of hijacking", async () => {
  const w = makeWorld({
    agent: makeAgent('muse'),
    captures: ["transcript\n❯ someone else's half sentence\nstatus"],
  })
  const r = await messageLocalAgent('probe-agent', 'hello', w.opts)
  assert.equal(r.ok, false)
  assert.equal(r.error, 'compose-busy')
  assert.equal(types(w.calls), 0, 'never types over it')
  assert.equal(w.exits[0], 1)
})

test("claude's ghost placeholder counts as an empty prompt", async () => {
  const w = makeWorld({
    agent: makeAgent('claude'),
    captures: [
      'banner\n❯ Try "fix typecheck errors"\nstatus',
      'banner\n❯ 💬 hi\nstatus',
      '❯ 💬 hi\n✽ Forging…\n❯ \nstatus',
    ],
  })
  const r = await messageLocalAgent('probe-agent', 'hi', w.opts)
  assert.equal(r.ok, true)
  assert.equal(types(w.calls), 1)
  assert.equal(enters(w.calls), 1)
})
