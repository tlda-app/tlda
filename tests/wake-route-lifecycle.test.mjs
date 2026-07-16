import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { FleetStore } from '../server/lib/fleet-store.mjs'
import { runWakeRouteLifecycle, shouldSendWakeNudge } from '../server/lib/wake-route-lifecycle.mjs'
import { SpawnLibrarian } from '../shared/spawn-librarian.ts'

const DAEMON = 'mac-mini:tlda'

function baseAgent(overrides = {}) {
  return {
    id: 'fleet:worker',
    friendly_name: 'worker',
    machine_id: 'mac-mini',
    env_name: 'tlda',
    tmux_session: 'fleet-worker',
    dead: false,
    human: false,
    metadata: { kind: 'codex', deliveryChannel: 'tmux' },
    ...overrides,
  }
}

function harness({ agent = baseAgent(), serverAlive = true, checkAlive = { alive: true }, spawnResult = { ok: true, tmux_session: 'fleet-worker-respawned' } } = {}) {
  const attempts = []
  const controls = []
  const rpc = []
  const nudges = []
  const acks = []
  const wedged = []
  const lifecycle = []
  const librarian = new SpawnLibrarian()
  let currentSeat = {
    agent_id: agent.id,
    session_id: 'session-worker',
    daemon_key: DAEMON,
    tmux_session: agent.tmux_session,
  }
  return {
    agent,
    attempts,
    controls,
    rpc,
    nudges,
    acks,
    wedged,
    lifecycle,
    async run(extra = {}) {
      return runWakeRouteLifecycle({
        agentId: agent.id,
        agent,
        seat: currentSeat,
        daemonKey: DAEMON,
        ownerDaemon: { readyState: 1 },
        nudgeText: 'Call inbox() to see it.',
        asker: 'fleet:chief',
        traceId: 'delegate:wake-route-test',
        source: { sourceEventId: 42, sourceTaskId: 'task:wake-route', priority: 'urgent' },
        isAgentAlive: () => serverAlive,
        async sendRpcResilient(machineId, op, params) {
          rpc.push({ kind: 'resilient', machineId, op, params })
          if (checkAlive instanceof Error) throw checkAlive
          return checkAlive
        },
        async sendRpc(machineId, op, params) {
          rpc.push({ kind: 'direct', machineId, op, params })
          if (spawnResult?.ok) {
            currentSeat = {
              ...currentSeat,
              daemon_key: 'mac-air:tlda',
              tmux_session: 'fleet-worker-bound',
            }
          }
          return spawnResult
        },
        spawnLibrarian: librarian,
        async recordWakeAttempt(attempt) {
          attempts.push(attempt)
          return { ok: true, eventId: attempts.length }
        },
        appendControlTrace(event) {
          controls.push(event)
        },
        async sendWakeNudge(daemonKey, wakeAgent, tmuxSession, text, phase, logTag, sessionId) {
          if (!shouldSendWakeNudge(wakeAgent, text)) return
          nudges.push({ daemonKey, tmuxSession, text, phase, logTag, sessionId })
        },
        getCurrentSeat() {
          return currentSeat
        },
        awaitWakeAcknowledgment(input) {
          acks.push(input)
        },
        broadcastEvent(type, payload) {
          wedged.push({ type, payload })
        },
        async insertWakeLifecycleEvent(input) {
          lifecycle.push(input)
        },
        ...extra,
      })
    },
  }
}

function tempStore(prefix = 'wake-route-lifecycle') {
  const dbPath = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.unlinkSync(file) } catch (e) {
      if (e?.code !== 'ENOENT') throw e
    }
  }
  return { store: new FleetStore(dbPath), dbPath }
}

function cleanup(store, dbPath) {
  store.close()
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.unlinkSync(file) } catch (e) {
      if (e?.code !== 'ENOENT') throw e
    }
  }
}

test('wake route does nothing after confirming the runtime is already awake', async () => {
  const h = harness()
  const result = await h.run()

  assert.equal(result.action, 'already-awake')
  assert.deepEqual(h.rpc.map(call => call.op), ['check-alive'])
  assert.deepEqual(h.nudges, [])
  assert.equal(h.acks.length, 0)
  assert.deepEqual(h.attempts.map(a => a.reason), [
    'daemon-route-selected',
    'check-alive',
    'spawn-librarian:deliver',
    'already-awake',
  ])
  assert.ok(h.attempts.every(a => a.traceId === 'delegate:wake-route-test'))
  assert.ok(h.attempts.every(a => a.sourceEventId === 42))
  assert.ok(h.attempts.every(a => a.sourceTaskId === 'task:wake-route'))
})

test('wake route records respawn and post-respawn terminal nudge for a server-hibernating agent', async () => {
  const h = harness({ serverAlive: false })
  const result = await h.run()

  assert.equal(result.action, 'respawned')
  assert.deepEqual(h.rpc.map(call => call.op), ['spawn'])
  assert.deepEqual(h.rpc[0].params, { name: 'fleet:worker', agent_id: 'fleet:worker', respawn: true })
  assert.deepEqual(
    h.nudges.map(nudge => [nudge.daemonKey, nudge.tmuxSession, nudge.phase, nudge.sessionId]),
    [['mac-air:tlda', 'fleet-worker-bound', 'post-respawn', 'session-worker']],
  )
  assert.deepEqual(h.lifecycle, [{ agentId: 'fleet:worker' }])
  assert.deepEqual(h.attempts.map(a => a.reason), [
    'daemon-route-selected',
    'check-alive',
    'spawn-librarian:respawn',
    'spawn-and-send-text-ok',
  ])
})

test('wake route refuses a successful respawn that did not establish an authoritative binding', async () => {
  const h = harness({ serverAlive: false })
  await assert.rejects(
    () => h.run({ getCurrentSeat: () => null }),
    /did not establish a current durable binding/,
  )
  assert.equal(h.nudges.length, 0)
  assert.equal(h.lifecycle.length, 0)
})

test('wake terminal eligibility distinguishes channel delivery from valid tmux nudges', async () => {
  assert.equal(shouldSendWakeNudge(baseAgent({ metadata: { kind: 'claude', deliveryChannel: 'channel' } }), 'wake'), false)
  assert.equal(shouldSendWakeNudge(baseAgent({ metadata: { kind: 'claude', deliveryChannel: 'tmux' } }), 'wake'), true)
  assert.equal(shouldSendWakeNudge(baseAgent({ metadata: { kind: 'codex', deliveryChannel: 'channel' } }), 'wake'), true)
  assert.equal(shouldSendWakeNudge(baseAgent({ tmux_session: null }), 'wake'), true)
})

test('wake route fails loudly when no tmux session can be nudged after a respawn', async () => {
  const h = harness({
    agent: baseAgent({ tmux_session: null }),
    serverAlive: false,
    spawnResult: { ok: false, reason: 'local wake ledger has no record for fleet:worker' },
  })

  await assert.rejects(
    () => h.run(),
    /no current durable seat/
  )
  assert.equal(h.lifecycle.length, 0)
})

test('wake route fails loudly for a missing or wrong daemon route', async () => {
  const h = harness()
  await assert.rejects(
    () => h.run({ ownerDaemon: null }),
    /No fleet-daemon connected for mac-mini:tlda/
  )
  assert.equal(h.attempts.at(-1).reason, 'daemon-route-selected')
})

test('wake route fails loudly when the agent has no current durable seat', async () => {
  const h = harness()
  await assert.rejects(
    () => h.run({ seat: null }),
    /no current durable seat/
  )
  assert.equal(h.attempts.at(-1).reason, 'daemon-route-selected')
})

test('wake route surfaces wedged decision instead of silently deferring', async () => {
  const h = harness({ checkAlive: { state: 'wedged', reason: 'delivered chat produced no agent-activity advance' } })
  const result = await h.run()

  assert.equal(result.action, 'surfaced')
  assert.deepEqual(h.wedged.map(event => event.type), ['agent-wedged'])
  assert.match(h.wedged[0].payload.reason, /agent-activity/)
  assert.equal(h.attempts.at(-1).reason, 'spawn-librarian:surface')
})

test('old lineage name resolution ignores a dead chief row before wake routing', () => {
  const { store, dbPath } = tempStore('wake-route-chief-lineage')
  try {
    store.setRuntimeStatusProvider(agent => ({ status: agent.id === 'fleet:chief-live' ? 'awake' : 'hibernating' }))
    store.upsertAgent({
      id: 'fleet:chief-old',
      friendly_name: 'chief',
      dead: true,
      last_seen: '2026-07-13T16:00:00.000Z',
    })
    store.upsertAgent({
      id: 'fleet:chief-live',
      friendly_name: 'chief',
      dead: false,
      last_seen: '2026-07-13T15:00:00.000Z',
    })

    assert.equal(store.findAgent('chief').id, 'fleet:chief-live')
  } finally {
    cleanup(store, dbPath)
  }
})
