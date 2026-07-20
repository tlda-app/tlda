#!/usr/bin/env node
import assert from 'node:assert/strict'

import { dismissAgent } from '../cli/tlda.mjs'

function createHarness({ seat, killError = null, seatError = null } = {}) {
  const calls = []
  const agent = {
    id: 'fleet:dismiss-test',
    friendly_name: 'dismiss-test',
    dead: false,
    labels: [],
  }
  const logLines = []
  return {
    calls,
    logLines,
    async run() {
      return dismissAgent('dismiss-test', {
        ensureServerImpl: async () => { calls.push(['ensure']) },
        apiImpl: async (method, url, body) => {
          calls.push([method, url, body || null])
          if (method === 'GET' && url === '/api/state') return { agents: [agent] }
          if (method === 'GET' && url.startsWith('/api/agent-seat?')) {
            if (seatError) throw Object.assign(new Error(seatError.message), { status: seatError.status })
            return { seat }
          }
          if (method === 'POST' && url === '/api/kill-session') {
            if (killError) throw new Error(killError)
            return { ok: true }
          }
          if (method === 'POST' && url === '/api/agents/fleet%3Adismiss-test/mark-dead') return { ok: true }
          throw new Error(`unexpected API call ${method} ${url}`)
        },
        log: {
          log: line => logLines.push(['log', line]),
          error: line => logLines.push(['error', line]),
        },
        exitImpl: code => { throw Object.assign(new Error(`exit ${code}`), { exitCode: code }) },
      })
    },
  }
}

{
  const harness = createHarness({
    seat: {
      agent_id: 'fleet:dismiss-test',
      session_id: 'rollout-dismiss-test',
      daemon_key: 'mini:prod',
      terminal_capability: 'termcap:dismiss-test',
    },
  })
  const result = await harness.run()
  assert.equal(result.ok, true)
  assert.equal(result.killed, true)
  assert.deepEqual(harness.calls.map(call => call[1]).filter(Boolean), [
    '/api/state',
    '/api/agent-seat?agent=fleet%3Adismiss-test',
    '/api/kill-session',
    '/api/agents/fleet%3Adismiss-test/mark-dead',
  ])
  assert.deepEqual(harness.calls[3], ['POST', '/api/kill-session', { agent: 'fleet:dismiss-test' }])
}

{
  const harness = createHarness({
    seat: {
      agent_id: 'fleet:dismiss-test',
      session_id: 'rollout-dismiss-test',
      daemon_key: 'mini:prod',
      terminal_capability: null,
    },
  })
  const result = await harness.run()
  assert.equal(result.ok, true)
  assert.equal(result.killed, false)
  assert(!harness.calls.some(call => call[1] === '/api/kill-session'))
  assert(harness.calls.some(call => call[1] === '/api/agents/fleet%3Adismiss-test/mark-dead'))
}

{
  const harness = createHarness({ seatError: { status: 404, message: 'current durable seat missing' } })
  const result = await harness.run()
  assert.equal(result.ok, true)
  assert.equal(result.killed, false)
  assert(!harness.calls.some(call => call[1] === '/api/kill-session'))
  assert(harness.calls.some(call => call[1] === '/api/agents/fleet%3Adismiss-test/mark-dead'))
}

{
  const harness = createHarness({
    seat: {
      agent_id: 'fleet:dismiss-test',
      session_id: 'rollout-dismiss-test',
      daemon_key: 'mini:prod',
      terminal_capability: 'termcap:dismiss-test',
    },
    killError: 'terminal refused teardown',
  })
  await assert.rejects(() => harness.run(), /exit 1/)
  assert(harness.calls.some(call => call[1] === '/api/kill-session'))
  assert(!harness.calls.some(call => call[1] === '/api/agents/fleet%3Adismiss-test/mark-dead'))
}

console.log('agent dismiss regression tests passed')
