import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentLiveness } from '../daemon/agent-liveness.mjs'

test('daemon liveness start refreshes hosted sessions immediately and every 30s by default', async () => {
  const sent = []
  const intervals = []
  const liveness = createAgentLiveness({
    getAgents: () => [{
      id: 'fleet:a',
      dead: false,
      human: false,
      tmux_session: 'fleet-a',
      metadata: {},
    }],
    listSessions: async () => ({ sessions: ['fleet-a'] }),
    sendMsg: msg => sent.push(msg),
    setIntervalFn: (fn, ms) => {
      intervals.push({ fn, ms })
      return { unref() {} }
    },
  })

  liveness.start()
  await Promise.resolve()
  assert.equal(intervals.length, 1)
  assert.equal(intervals[0].ms, 30_000)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].reason, 'periodic-hosted-session-refresh')
  assert.deepEqual(sent[0].agent_ids, ['fleet:a'])
  assert.deepEqual(sent[0].checked_agent_ids, ['fleet:a'])

  intervals[0].fn()
  await Promise.resolve()
  assert.equal(sent.length, 2)
  assert.equal(sent[1].reason, 'periodic-hosted-session-refresh')
})

test('daemon liveness refresh reports missing hosted panes as checked dead', async () => {
  const sent = []
  const liveness = createAgentLiveness({
    getAgents: () => [{
      id: 'fleet:a',
      dead: false,
      human: false,
      tmux_session: 'fleet-a',
      metadata: {},
    }],
    listSessions: async () => ({ sessions: [] }),
    sendMsg: msg => sent.push(msg),
    setIntervalFn: () => ({ unref() {} }),
  })

  await liveness.reportHostedSessions('manual-test')
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].agent_ids, [])
  assert.deepEqual(sent[0].checked_agent_ids, ['fleet:a'])
})
