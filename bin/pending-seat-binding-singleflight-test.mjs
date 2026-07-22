import assert from 'node:assert/strict'
import test from 'node:test'

import { createPendingSeatBindingManager } from '../agent-launch/pending-seat-binding.mjs'

test('pending seat binding identity probes are serialized across obligations', async () => {
  const timers = []
  const completes = []
  const resolveStarted = []
  let releaseFirst
  const firstResolve = new Promise(resolve => {
    releaseFirst = () => resolve({ sessionId: 'session-a', model: 'gpt-test' })
  })

  const manager = createPendingSeatBindingManager({
    watchPath: obligation => `/tmp/${obligation.obligation_id}`,
    watch: () => ({ close() {} }),
    setPeriodic: fn => {
      timers.push(fn)
      return { unref() {} }
    },
    clearPeriodic: () => {},
    tmuxAlive: async () => true,
    resolveIdentity: async obligation => {
      resolveStarted.push(obligation.obligation_id)
      if (obligation.obligation_id === 'a') return firstResolve
      return { sessionId: 'session-b', model: 'gpt-test' }
    },
    complete: async (obligation, identity) => {
      completes.push([obligation.obligation_id, identity.sessionId])
    },
    terminal: async () => {},
    log: { warn: () => {} },
  })

  manager.accept({ obligation_id: 'a', tmux_session: 'tmux-a' })
  manager.accept({ obligation_id: 'b', tmux_session: 'tmux-b' })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(resolveStarted, ['a'])
  assert.deepEqual(completes, [])

  releaseFirst()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(resolveStarted, ['a', 'b'])
  assert.deepEqual(completes, [['a', 'session-a'], ['b', 'session-b']])
  assert.equal(timers.length, 2)
})

test('a live runtime survives a failed binding and binds on a later JSONL change', async () => {
  let completeAttempts = 0
  let terminalCalls = 0
  const warnings = []
  const manager = createPendingSeatBindingManager({
    watchPath: () => '/tmp/runtime-jsonl',
    watch: () => ({ close() {} }),
    setPeriodic: () => ({ unref() {} }),
    clearPeriodic: () => {},
    tmuxAlive: async () => true,
    resolveIdentity: async () => ({ sessionId: 'session-live', model: 'gpt-test', jsonlPath: '/tmp/runtime-jsonl/session-live.jsonl' }),
    complete: async () => {
      completeAttempts += 1
      if (completeAttempts === 1) throw Object.assign(new Error('database temporarily unavailable'), { terminalBindingFailure: true })
    },
    terminal: async () => { terminalCalls += 1 },
    log: { warn: message => warnings.push(message) },
  })

  const obligation = { obligation_id: 'live', tmux_session: 'tmux-live' }
  assert.equal(manager.accept(obligation), true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(manager.has('live'), true)
  assert.equal(terminalCalls, 0)
  assert.match(warnings[0], /runtime\/session binding .* remains pending/)

  await manager.attempt(obligation)
  assert.equal(completeAttempts, 2)
  assert.equal(manager.has('live'), false)
  assert.equal(terminalCalls, 0)
})
