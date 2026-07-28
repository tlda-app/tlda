#!/usr/bin/env node
import assert from 'node:assert/strict'
import test from 'node:test'

import { attachToAgent } from '../cli/tlda.mjs'

function harness({ seat, route }) {
  const calls = []
  const exits = []
  const apiImpl = async (method, path) => {
    calls.push([method, path])
    if (path === '/api/state') {
      return { agents: [{ id: 'fleet:agent-1', friendly_name: 'chief13' }] }
    }
    return { seat }
  }
  const spawnCalls = []
  const spawnSyncImpl = (...args) => {
    spawnCalls.push(args)
    return { status: 0 }
  }
  const ledger = {
    get: id => {
      assert.equal(id, 'fleet:agent-1')
      return route
    },
    close: async () => {},
  }
  return {
    calls,
    exits,
    spawnCalls,
    options: {
      apiImpl,
      spawnSyncImpl,
      exitImpl: code => exits.push(code),
      localDaemonKeyImpl: () => 'mini:testing',
      openLedger: () => ledger,
      log: { log() {}, error() {} },
    },
  }
}

test('attach resolves the authoritative seat and uses its capability-backed local route', async () => {
  const seat = {
    agent_id: 'fleet:agent-1',
    session_id: 'session-real',
    daemon_key: 'mini:testing',
    terminal_capability: 'termcap-real',
  }
  const h = harness({
    seat,
    route: {
      sessionId: 'session-real',
      terminalCapability: 'termcap-real',
      tmuxSession: 'fleet-real-session',
    },
  })

  const result = await attachToAgent('chief13', h.options)

  assert.equal(result.ok, true)
  assert.deepEqual(h.calls, [
    ['GET', '/api/state'],
    ['GET', '/api/agent-seat?agent=fleet%3Aagent-1'],
  ])
  assert.equal(h.spawnCalls[0][0], 'tmux')
  assert.deepEqual(h.spawnCalls[0][1].slice(-3), ['attach-session', '-t', '=fleet-real-session'])
  assert.deepEqual(h.exits, [0])
})

test('attach refuses a guessed tmux fallback when the durable seat and local route disagree', async () => {
  const h = harness({
    seat: {
      agent_id: 'fleet:agent-1',
      session_id: 'session-real',
      daemon_key: 'mini:testing',
      terminal_capability: 'termcap-real',
    },
    route: {
      sessionId: 'session-real',
      terminalCapability: 'different-capability',
      tmuxSession: 'fleet-chief13',
    },
  })

  const result = await attachToAgent('chief13', h.options)

  assert.equal(result.ok, false)
  assert.equal(result.error, 'seat-route-mismatch')
  assert.equal(h.spawnCalls.length, 0)
  assert.deepEqual(h.exits, [1])
})
