import assert from 'node:assert/strict'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { cleanupPendingSeatBinding, completePendingSeatBinding, createPendingSeatBindingManager } from '../agent-launch/pending-seat-binding.mjs'
import { AgentSeatBindingObligations, verifyAgentSeatBindingTerminal } from '../server/lib/agent-seat-binding-obligations.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))

function periodicHarness() {
  const callbacks = new Set()
  const cleared = []
  return {
    callbacks,
    cleared,
    setPeriodic(callback) {
      const timer = { unrefCalled: false, unref() { this.unrefCalled = true } }
      callbacks.add(callback)
      timer.callback = callback
      return timer
    },
    clearPeriodic(timer) {
      cleared.push(timer)
      callbacks.delete(timer.callback)
    },
    fire() {
      for (const callback of [...callbacks]) callback()
    },
  }
}

test('periodic retry completes an identity that appears without a filesystem event', async () => {
  const periodic = periodicHarness()
  let identity = null
  const completed = []
  const manager = createPendingSeatBindingManager({
    watchPath: () => '/runtime-events',
    watch: () => ({ close() {} }),
    setPeriodic: periodic.setPeriodic,
    clearPeriodic: periodic.clearPeriodic,
    tmuxAlive: async () => true,
    resolveIdentity: async () => identity,
    complete: async (_obligation, exact) => completed.push(exact.sessionId),
    terminal: async () => assert.fail('must not terminate'),
  })
  manager.accept({ obligation_id: 'o-periodic', tmux_session: 'fleet-periodic' })
  await tick()
  assert.equal(periodic.callbacks.size, 1)
  identity = { sessionId: 'owned-session', model: 'gpt-5.6-sol' }
  periodic.fire()
  await tick()
  assert.deepEqual(completed, ['owned-session'])
  assert.equal(periodic.callbacks.size, 0)
  assert.equal(periodic.cleared.length, 1)
  periodic.fire()
  await tick()
  assert.equal(completed.length, 1)
})

test('periodic retry is unref-safe and close prevents later callbacks', async () => {
  const periodic = periodicHarness()
  let attempts = 0
  const manager = createPendingSeatBindingManager({
    watchPath: () => '/runtime-events',
    watch: () => ({ close() {} }),
    setPeriodic: periodic.setPeriodic,
    clearPeriodic: periodic.clearPeriodic,
    tmuxAlive: async () => true,
    resolveIdentity: async () => { attempts += 1; return null },
    complete: async () => assert.fail('cannot complete'),
    terminal: async () => assert.fail('must not terminate'),
  })
  manager.accept({ obligation_id: 'o-close', tmux_session: 'fleet-close' })
  await tick()
  assert.equal(attempts, 1)
  manager.close()
  assert.equal(periodic.callbacks.size, 0)
  assert.equal(periodic.cleared.length, 1)
  assert.equal(periodic.cleared[0].unrefCalled, true)
  periodic.fire()
  await tick()
  assert.equal(attempts, 1)
})

test('delayed exact-process event completes once and duplicate delivery is idempotent', async () => {
  let fire
  let identity = null
  const completed = []
  const manager = createPendingSeatBindingManager({
    watchPath: () => '/runtime-events',
    watch: (_path, _options, callback) => { fire = callback; return { close() {} } },
    tmuxAlive: async () => true,
    resolveIdentity: async () => identity,
    complete: async (obligation, exact) => completed.push([obligation.obligation_id, exact.sessionId]),
    terminal: async () => assert.fail('must not terminate'),
  })
  const obligation = { obligation_id: 'o1', tmux_session: 'fleet-a' }
  assert.equal(manager.accept(obligation), true)
  assert.equal(manager.accept(obligation), false)
  await tick()
  assert.deepEqual(completed, [])
  identity = { sessionId: 'owned-session', model: 'gpt-5.6-sol' }
  fire('change', 'owned.jsonl')
  await tick()
  assert.deepEqual(completed, [['o1', 'owned-session']])
  fire('change', 'adjacent.jsonl')
  await tick()
  assert.equal(completed.length, 1)
})

test('real completion path retains watcher on uncertain bind and later exact event completes once', async () => {
  let fire
  let attempts = 0
  const emitted = []
  const obligation = {
    obligation_id: 'o-uncertain', agent_id: 'fleet:a', daemon_key: 'mini:default', tmux_session: 'fleet-a',
  }
  const identity = { sessionId: 'owned-session', model: 'gpt-5.6-sol' }
  const manager = createPendingSeatBindingManager({
    watchPath: () => '/runtime-events',
    watch: (_path, _options, callback) => { fire = callback; return { close() {} } },
    tmuxAlive: async () => true,
    resolveIdentity: async () => identity,
    complete: (currentObligation, currentIdentity) => completePendingSeatBinding({
      obligation: currentObligation,
      identity: currentIdentity,
      bindSeat: async () => {
        attempts += 1
        if (attempts === 1) return { bound: false, pending: true, submitError: new Error('uncertain POST'), readError: new Error('uncertain GET') }
        return {
          bound: true,
          seat: { agent_id: 'fleet:a', session_id: 'owned-session', tmux_session: 'fleet-a', daemon_key: 'mini:default' },
        }
      },
      emitComplete: async message => emitted.push(message),
    }),
    terminal: async () => assert.fail('must not terminate'),
    log: { warn() {} },
  })
  manager.accept(obligation)
  await tick()
  assert.equal(manager.pendingCount(), 1)
  assert.equal(attempts, 1)
  assert.deepEqual(emitted, [])
  fire('change', 'owned.jsonl')
  await tick()
  assert.equal(manager.pendingCount(), 0)
  assert.equal(attempts, 2)
  assert.equal(emitted.length, 1)
  fire('change', 'owned.jsonl')
  await tick()
  assert.equal(attempts, 2)
  assert.equal(emitted.length, 1)
})

test('terminal loss of the exact runtime invokes exact cleanup once', async () => {
  const periodic = periodicHarness()
  const terminal = []
  const manager = createPendingSeatBindingManager({
    watchPath: () => '/runtime-events',
    watch: () => ({ close() {} }),
    setPeriodic: periodic.setPeriodic,
    clearPeriodic: periodic.clearPeriodic,
    tmuxAlive: async () => false,
    resolveIdentity: async () => assert.fail('dead runtime has no identity'),
    complete: async () => assert.fail('dead runtime cannot complete'),
    terminal: async (obligation, error) => terminal.push([obligation.obligation_id, error.message]),
  })
  manager.accept({ obligation_id: 'o-dead', tmux_session: 'fleet-dead' })
  await tick()
  assert.deepEqual(terminal, [['o-dead', 'exact launched runtime is no longer alive']])
  assert.equal(manager.pendingCount(), 0)
  assert.equal(periodic.callbacks.size, 0)
  assert.equal(periodic.cleared.length, 1)
})

test('terminal cleanup failure retains the durable obligation', async () => {
  const manager = createPendingSeatBindingManager({
    watchPath: () => '/runtime-events',
    watch: () => ({ close() {} }),
    tmuxAlive: async () => false,
    resolveIdentity: async () => null,
    complete: async () => assert.fail('cannot complete'),
    terminal: async () => { throw new Error('exact runtime still live') },
    log: { warn() {} },
  })
  manager.accept({ obligation_id: 'o-retained', tmux_session: 'fleet-retained' })
  await tick()
  assert.equal(manager.pendingCount(), 1)
})

test('server-held obligation survives reconstruction and is cleared only explicitly', () => {
  const db = new Database(':memory:')
  const first = new AgentSeatBindingObligations(db, { clock: () => '2026-07-18T00:00:00.000Z' })
  const stored = first.put({
    agent_id: 'fleet:a', daemon_key: 'mini:default', tmux_session: 'fleet-a',
    cwd: '/work', kind: 'codex', model: 'gpt-5.6-sol', friendly_name: 'a', process_owned_only: true,
  })
  const afterReconnect = new AgentSeatBindingObligations(db)
  assert.equal(afterReconnect.listForDaemon('mini:default')[0].obligation_id, stored.obligation_id)
  assert.equal(afterReconnect.remove(stored.obligation_id), true)
  assert.deepEqual(afterReconnect.listForDaemon('mini:default'), [])
  db.close()
})

function cleanupHarness({ permissionDelete, localDelete, retire } = {}) {
  const emitted = []
  const permissionRows = new Map([['fleet:a', { id: 'fleet:a' }]])
  const localRows = new Map([['local:a', { id: 'local:a' }]])
  const permissionLedger = {
    async delete(id) {
      if (permissionDelete) return permissionDelete(id)
      permissionRows.delete(id)
    },
    get: id => permissionRows.get(id) || null,
  }
  const openLocalLedger = () => ({
    get: id => localRows.get(id) || null,
    delete(id) {
      if (localDelete) return localDelete(id, localRows)
      localRows.delete(id); return true
    },
    close() {},
  })
  const obligation = {
    obligation_id: 'o-cleanup', agent_id: 'fleet:a', local_agent_id: 'local:a',
    daemon_key: 'mini:default', tmux_session: 'fleet-a',
  }
  return {
    emitted,
    obligation,
    run: () => cleanupPendingSeatBinding({
      obligation, error: new Error('terminal binding rejection'),
      terminateTmux: async () => {}, tmuxAlive: async () => false,
      permissionLedger, openLocalLedger,
      retireServerReservation: retire || (async () => ({ ok: true, retired: true })),
      emitTerminal: async message => emitted.push(message),
    }),
  }
}

async function runCleanupFailureThroughManager(harness) {
  const manager = createPendingSeatBindingManager({
    watchPath: () => '/runtime-events', watch: () => ({ close() {} }),
    tmuxAlive: async () => false, resolveIdentity: async () => null,
    complete: async () => assert.fail('cannot complete'),
    terminal: () => harness.run(), log: { warn() {} },
  })
  manager.accept(harness.obligation)
  await tick()
  return manager
}

test('real terminal path retains obligation when permission deletion fails', async () => {
  const h = cleanupHarness({ permissionDelete: async () => { throw new Error('ledger write failed') } })
  const manager = await runCleanupFailureThroughManager(h)
  assert.equal(manager.pendingCount(), 1)
  assert.deepEqual(h.emitted, [])
})

test('real terminal path retains obligation when local recipe deletion fails', async () => {
  const h = cleanupHarness({ localDelete: () => false })
  const manager = await runCleanupFailureThroughManager(h)
  assert.equal(manager.pendingCount(), 1)
  assert.deepEqual(h.emitted, [])
})

test('real terminal path retains obligation when mark-dead is unverified', async () => {
  const h = cleanupHarness({ retire: async () => { throw new Error('mark-dead failed') } })
  const manager = await runCleanupFailureThroughManager(h)
  assert.equal(manager.pendingCount(), 1)
  assert.deepEqual(h.emitted, [])
})

test('stale or mismatched terminal event cannot clear a server obligation', () => {
  const obligation = { obligation_id: 'o1', agent_id: 'fleet:a', daemon_key: 'mini:default' }
  const retired = { dead: 1 }
  assert.throws(() => verifyAgentSeatBindingTerminal({
    obligation,
    message: { agent_id: 'fleet:wrong', daemon_key: 'mini:default' },
    daemonKey: 'mini:default', agent: retired, seat: null,
  }), /identity mismatch/)
  assert.throws(() => verifyAgentSeatBindingTerminal({
    obligation,
    message: { agent_id: 'fleet:a', daemon_key: 'mini:default' },
    daemonKey: 'mini:other', agent: retired, seat: null,
  }), /identity mismatch/)
  assert.throws(() => verifyAgentSeatBindingTerminal({
    obligation,
    message: { agent_id: 'fleet:a', daemon_key: 'mini:default' },
    daemonKey: 'mini:default', agent: { dead: 0 }, seat: null,
  }), /retirement is not verified/)
})
