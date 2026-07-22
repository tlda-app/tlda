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
