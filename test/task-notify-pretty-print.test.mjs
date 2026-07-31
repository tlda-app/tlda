import assert from 'node:assert/strict'
import test from 'node:test'

import { formatTaskNotify, classifyTaskAgentHealth } from '../mcp-server/fleet-tools.mjs'

test('formatTaskNotify marks a future notify_at as deferred, with absolute + relative time', () => {
  const notifyAt = new Date(Date.now() + 12 * 60000).toISOString()
  const out = formatTaskNotify(notifyAt)
  assert.match(out, /^deferred — notify in 12m \(.+\)$/)
})

test('formatTaskNotify reads elapsed, not deferred, once notify_at has passed', () => {
  const notifyAt = new Date(Date.now() - 387 * 60000).toISOString()
  const out = formatTaskNotify(notifyAt)
  assert.match(out, /^notify 387m ago \(.+\)$/)
  assert.doesNotMatch(out, /deferred/)
})

test('formatTaskNotify compact mode drops the absolute clock', () => {
  const notifyAt = new Date(Date.now() + 12 * 60000).toISOString()
  assert.equal(formatTaskNotify(notifyAt, { compact: true }), 'deferred — notify in 12m')
})

test('formatTaskNotify returns null with no notify_at', () => {
  assert.equal(formatTaskNotify(undefined), null)
  assert.equal(formatTaskNotify(null), null)
})

test('classifyTaskAgentHealth does not fire pending-pickup for a task correctly waiting on a future notify_at', () => {
  const nowMs = Date.parse('2026-07-30T15:00:00.000Z')
  const task = {
    status: 'pending',
    delegated_at: '2026-07-30T08:00:00.000Z', // 7h ago — would trip the old delegation-age check
    metadata: { notify_at: '2026-07-30T16:00:00.000Z' }, // still an hour out
  }
  const agent = { id: 'a1', friendly_name: 'a1', last_seen: '2026-07-30T14:59:00.000Z', runtime_status: { kind: 'ai', status: 'awake' } }
  const health = classifyTaskAgentHealth(task, agent, { nowMs })
  assert.equal(health.level, 'ok')
})

test('classifyTaskAgentHealth fires pending-pickup, keyed to notify_at, once a deferred task is overdue', () => {
  const nowMs = Date.parse('2026-07-30T15:44:19.000Z')
  const task = {
    status: 'pending',
    delegated_at: '2026-07-30T09:00:00.000Z', // matches the 387m-ago report Skip flagged
    metadata: { notify_at: '2026-07-30T15:44:19.000Z' }, // notify just fired
  }
  const agent = { id: 'a1', friendly_name: 'a1', last_seen: '2026-07-30T15:53:00.000Z', runtime_status: { kind: 'ai', status: 'awake' } }
  // 10 minutes after notify_at: overdue against notify, not delegation.
  const health = classifyTaskAgentHealth(task, agent, { nowMs: nowMs + 10 * 60000 })
  assert.equal(health.code, 'pending-pickup')
  assert.match(health.text, /still pending 10m after notify/)
})

test('classifyTaskAgentHealth still keys pending-pickup off delegation when there is no notify_at', () => {
  const nowMs = Date.parse('2026-07-30T15:00:00.000Z')
  const task = {
    status: 'pending',
    delegated_at: '2026-07-30T14:00:00.000Z', // 1h ago, no notify_at at all
    metadata: {},
  }
  const agent = { id: 'a1', friendly_name: 'a1', last_seen: '2026-07-30T14:59:00.000Z', runtime_status: { kind: 'ai', status: 'awake' } }
  const health = classifyTaskAgentHealth(task, agent, { nowMs })
  assert.equal(health.code, 'pending-pickup')
  assert.match(health.text, /still pending 60m after delegation/)
})
