import assert from 'node:assert/strict'
import test from 'node:test'

import { decideTaskRenudges, isWakeBreakerOpen, wakeBreakerBackoffMs } from '../server/lib/task-renudge.mjs'

const now = Date.parse('2026-07-06T10:00:00.000Z')

function task(overrides = {}) {
  return {
    id: 'task-1',
    agent: 'fleet:agent-1',
    description: 'Do the thing',
    delegated_at: new Date(now - 10 * 60_000).toISOString(),
    status: 'pending',
    ...overrides,
  }
}

function event(overrides = {}) {
  return {
    id: 42,
    type: 'delegate',
    timestamp: new Date(now - 10 * 60_000).toISOString(),
    text: 'Do the thing',
    ...overrides,
  }
}

function state(overrides = {}) {
  return {
    task: task(overrides.task),
    event: event(overrides.event),
    unreadPending: overrides.unreadPending ?? true,
  }
}

function agent(overrides = {}) {
  return {
    id: 'fleet:agent-1',
    friendly_name: 'agent-1',
    status: 'awake',
    dead: false,
    human: false,
    ...overrides,
  }
}

test('renudges active unread delegate tasks for awake agents', () => {
  const nudges = decideTaskRenudges({
    taskStates: [state()],
    agents: [agent()],
    now,
  })

  assert.equal(nudges.length, 1)
  assert.equal(nudges[0].key, '42')
  assert.equal(nudges[0].reason, 'unread-task-delivery-due')
})

test('stops when the delegate event has been read', () => {
  const nudges = decideTaskRenudges({
    taskStates: [state({ unreadPending: false })],
    agents: [agent()],
    now,
  })

  assert.equal(nudges.length, 0)
})

test('skips blocked deferred done and shell tasks', () => {
  const cases = [
    state({ task: { id: 'task-blocked', agent: 'fleet:blocked', status: 'blocked', blockedBy: ['fleet:other'] }, event: { id: 101 } }),
    state({ task: { id: 'task-deferred', agent: 'fleet:deferred', metadata: { deferred: true } }, event: { id: 102 } }),
    state({ task: { id: 'task-done', agent: 'fleet:done', status: 'done' }, event: { id: 103 } }),
    state({ task: { id: 'task-shell', agent: 'fleet:shell' }, event: { id: 104 } }),
  ]
  const agents = [
    agent({ id: 'fleet:blocked' }),
    agent({ id: 'fleet:deferred' }),
    agent({ id: 'fleet:done' }),
    agent({ id: 'fleet:shell', status: 'shell' }),
  ]

  assert.equal(decideTaskRenudges({ taskStates: cases, agents, now }).length, 0)
})

test('backs off per delegate event', () => {
  const lastRenudged = new Map([['42', now - 60_000]])
  const first = decideTaskRenudges({
    taskStates: [state()],
    agents: [agent()],
    now,
    lastRenudged,
    renudgeIntervalMs: 5 * 60_000,
  })
  const second = decideTaskRenudges({
    taskStates: [state()],
    agents: [agent()],
    now,
    lastRenudged: new Map([['42', now - 6 * 60_000]]),
    renudgeIntervalMs: 5 * 60_000,
  })

  assert.equal(first.length, 0)
  assert.equal(second.length, 1)
})

test('includes hibernating agents so requestWake can respawn them', () => {
  const nudges = decideTaskRenudges({
    taskStates: [state()],
    agents: [agent({ status: 'hibernating' })],
    now,
  })

  assert.equal(nudges.length, 1)
  assert.equal(nudges[0].reason, 'hibernating-unread-task')
})

test('wake breaker gates an agent whose breaker is open', () => {
  const wakeBreaker = new Map([['fleet:agent-1', { fails: 2, nextTs: now + 10 * 60_000 }]])
  const nudges = decideTaskRenudges({ taskStates: [state()], agents: [agent()], now, wakeBreaker })
  assert.equal(nudges.length, 0)
})

test('wake breaker reopens once nextTs has passed', () => {
  const wakeBreaker = new Map([['fleet:agent-1', { fails: 2, nextTs: now - 1 }]])
  const nudges = decideTaskRenudges({ taskStates: [state()], agents: [agent()], now, wakeBreaker })
  assert.equal(nudges.length, 1)
})

test('a breaker on a different agent does not gate this one', () => {
  const wakeBreaker = new Map([['fleet:other', { fails: 3, nextTs: now + 60 * 60_000 }]])
  const nudges = decideTaskRenudges({ taskStates: [state()], agents: [agent()], now, wakeBreaker })
  assert.equal(nudges.length, 1)
})

test('isWakeBreakerOpen: open only while nextTs is in the future', () => {
  const m = new Map([['a', { nextTs: now + 1000 }], ['b', { nextTs: now - 1000 }]])
  assert.equal(isWakeBreakerOpen(m, 'a', now), true)
  assert.equal(isWakeBreakerOpen(m, 'b', now), false)
  assert.equal(isWakeBreakerOpen(m, 'missing', now), false)
  assert.equal(isWakeBreakerOpen(null, 'a', now), false)
})

test('wakeBreakerBackoffMs: exponential with cap (5→10→20→40→80→120→120 min)', () => {
  const base = 5 * 60_000
  const cap = 120 * 60_000
  const mins = [1, 2, 3, 4, 5, 6, 7].map(f => wakeBreakerBackoffMs(f, base, cap) / 60_000)
  assert.deepEqual(mins, [5, 10, 20, 40, 80, 120, 120])
})
