// F1: dismiss reaps before it retires. `dismissAgent` POSTs /api/kill-session
// before mark-dead and refuses to mark dead on any unverified kill —
// transport failure, or ok-but-terminal_unresolved (daemon did nothing, the
// process is very likely still running). Confirmed-absent proceeds.
//
// Fails against the pre-F1 dismiss, which posted mark-dead with no kill.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { dismissAgent } from '../cli/tlda.mjs'

function harness({ agents, kill }) {
  const posts = []
  const apiImpl = async (method, url, body) => {
    if (method === 'GET' && url === '/api/state') return { agents }
    if (method === 'POST' && url === '/api/kill-session') {
      posts.push(['kill-session', body])
      if (kill instanceof Error) throw kill
      return kill
    }
    if (method === 'POST' && url.endsWith('/mark-dead')) {
      posts.push(['mark-dead', body])
      return { ok: true }
    }
    throw new Error(`unexpected call ${method} ${url}`)
  }
  const exits = []
  return { posts, exits, apiImpl, log: { log: () => {}, error: () => {} }, exitImpl: (code) => exits.push(code) }
}

const live = [{ id: 'fleet:doomed', friendly_name: 'doomed', dead: 0 }]

test('dismiss kills before marking dead, naming its actor', async () => {
  const h = harness({ agents: live, kill: { ok: true } })
  const result = await dismissAgent('doomed', h)
  assert.equal(result.ok, true)
  assert.equal(result.killed, true)
  assert.deepEqual(h.posts.map(([name]) => name), ['kill-session', 'mark-dead'])
  assert.equal(h.posts[0][1].agent, 'fleet:doomed')
  assert.equal(h.posts[1][1].actor, 'tlda-agent-dismiss')
  assert.deepEqual(h.exits, [])
})

test('dismiss refuses when the kill fails', async () => {
  const err = new Error('agent has no daemon route')
  err.status = 409
  const h = harness({ agents: live, kill: err })
  const result = await dismissAgent('doomed', h)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'kill-failed')
  assert.deepEqual(h.posts.map(([name]) => name), ['kill-session'])
  assert.deepEqual(h.exits, [1])
})

test('dismiss refuses on ok-but-unresolved kill', async () => {
  const h = harness({ agents: live, kill: { ok: true, already_unavailable: true, terminal_unresolved: true, reason: 'no ledger row' } })
  const result = await dismissAgent('doomed', h)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'kill-unresolved')
  assert.deepEqual(h.posts.map(([name]) => name), ['kill-session'])
  assert.deepEqual(h.exits, [1])
})

test('dismiss proceeds when the session is confirmed absent', async () => {
  const h = harness({ agents: live, kill: { ok: true, already_unavailable: true, reason: 'tmux session already absent' } })
  const result = await dismissAgent('doomed', h)
  assert.equal(result.ok, true)
  assert.equal(result.killed, false)
  assert.deepEqual(h.posts.map(([name]) => name), ['kill-session', 'mark-dead'])
})

test('dismissing a dead agent posts nothing', async () => {
  const h = harness({ agents: [{ id: 'fleet:gone', friendly_name: 'gone', dead: 1 }], kill: { ok: true } })
  const result = await dismissAgent('gone', h)
  assert.equal(result.ok, true)
  assert.equal(result.already, true)
  assert.deepEqual(h.posts, [])
})
