import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { applyDaemonAgentStatusBatch, planDaemonAgentStatusBatch, validateDaemonAgentStatusBatch } from './daemon-agent-status.mjs'
import { createAgentRuntimeStatusStore } from './agent-runtime-status.mjs'
import { FleetStore } from './fleet-store.mjs'
import { FleetStoreClient } from './fleet-store-client.mjs'

const agent = { id: 'fleet:owned', route_daemon_key: 'mini:testing' }
const omittedAgent = { id: 'fleet:omitted', route_daemon_key: 'mini:testing' }
const message = {
  daemon_key: 'mini:testing',
  daemon_boot_id: 7,
  report_seq: 2,
  snapshot_complete: true,
  agents: [{ agent_id: 'fleet:owned', status: 'awake', activity: 'thinking', tool: null }],
}

test('plans admission for an authenticated live unknown while replacing registered routed agents only', () => {
  const live = {
    ...message,
    agents: [
      { ...message.agents[0], identity: { friendly_name: 'owned', runtime_kind: 'codex' } },
      { agent_id: 'fleet:new', status: 'awake', activity: 'idle', tool: null, identity: { friendly_name: 'new', runtime_kind: 'codex' } },
    ],
  }
  assert.deepEqual(planDaemonAgentStatusBatch({
    message: live,
    daemonKey: 'mini:testing',
    bootId: 7,
    lastSequence: 1,
    routedAgents: [agent, omittedAgent],
    knownAgents: [agent],
  }), {
    sequence: 2,
    admissions: [
      { id: 'fleet:owned', create: false, friendly_name: 'owned', runtime_kind: 'codex' },
      { id: 'fleet:new', create: true, friendly_name: 'new', runtime_kind: 'codex' },
    ],
    results: [
      ...live.agents,
      { agent_id: 'fleet:omitted', status: 'hibernating', activity: 'unknown', tool: null },
    ],
  })
})

test('does not admit a stale unknown that is absent from the authenticated live process batch', () => {
  const live = {
    ...message,
    agents: [{ ...message.agents[0], identity: { friendly_name: 'owned', runtime_kind: 'codex' } }],
  }
  const planned = planDaemonAgentStatusBatch({
    message: live,
    daemonKey: 'mini:testing',
    bootId: 7,
    lastSequence: 1,
    routedAgents: [agent],
    knownAgents: [{ id: 'fleet:stale', route_daemon_key: null }, agent],
  })
  assert.deepEqual(planned.admissions, [
    { id: 'fleet:owned', create: false, friendly_name: 'owned', runtime_kind: 'codex' },
  ])
  assert.deepEqual(planned.results, live.agents)
})

test('admission creates the authenticated live identity and routes it into the daemon roster', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-status-admission-'))
  try {
    const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
    store.admitDaemonAgentStatusIdentities([{
      id: 'fleet:new',
      create: true,
      friendly_name: 'new',
      runtime_kind: 'codex',
    }], 'mini:testing')
    const routed = store.getAgentsByDaemonKey('mini:testing')
    assert.deepEqual(routed.map(row => ({ id: row.id, name: row.friendly_name, route: row.route_daemon_key })), [
      { id: 'fleet:new', name: 'new', route: 'mini:testing' },
    ])
    assert.equal(store.getAgent('fleet:stale'), null)
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('admission rejects a live process claim on a human identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-status-human-'))
  try {
    const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
    store.upsertAgent({ id: 'human:skip', friendly_name: 'skip', labels: [], human: true })
    assert.throws(() => store.admitDaemonAgentStatusIdentities([{
      id: 'human:skip', create: false, friendly_name: 'skip', runtime_kind: 'codex',
    }], 'mini:testing'), /cannot claim human identity/)
    assert.equal(store.getAgentDaemonRoute('human:skip'), null)
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('admission deliberately revives an authenticated dead AI identity while preserving its canonical name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-status-revive-'))
  try {
    const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
    store.upsertAgent({ id: 'fleet:resumed', friendly_name: 'old-name', labels: [], dead: true, metadata: { kind: 'claude' } })
    store.admitDaemonAgentStatusIdentities([{
      id: 'fleet:resumed', create: false, friendly_name: 'resumed', runtime_kind: 'codex',
    }], 'mini:testing')
    const resumed = store.getAgent('fleet:resumed')
    assert.equal(resumed.dead, false)
    assert.equal(resumed.friendly_name, 'old-name')
    assert.equal(resumed.metadata.kind, 'codex')
    assert.equal(resumed.route_daemon_key, 'mini:testing')
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a competing daemon cannot take an identity already claimed by another daemon', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-status-claim-'))
  try {
    const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
    const identity = { id: 'fleet:claimed', create: true, friendly_name: 'claimed', runtime_kind: 'codex' }
    store.admitDaemonAgentStatusIdentities([identity], 'mini:testing')
    assert.throws(() => store.admitDaemonAgentStatusIdentities([{ ...identity, create: false }], 'mini:stable'), /already claimed/)
    assert.equal(store.getAgentDaemonRoute('fleet:claimed').daemon_key, 'mini:testing')
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a later inadmissible route rolls back every earlier admission in the batch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-status-rollback-'))
  try {
    const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
    store.upsertAgent({ id: 'fleet:collision', friendly_name: 'collision', labels: [], dead: true })
    store.setAgentDaemonRoute('fleet:collision', 'mini:stable')
    assert.throws(() => store.admitDaemonAgentStatusIdentities([
      { id: 'fleet:first', create: true, friendly_name: 'first', runtime_kind: 'codex' },
      { id: 'fleet:collision', create: false, friendly_name: 'process-name-is-not-authority', runtime_kind: 'codex' },
    ], 'mini:testing'), /already claimed/)
    assert.equal(store.getAgent('fleet:first'), null)
    assert.equal(store.getAgentDaemonRoute('fleet:first'), null)
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the live 4/3/3/7 duplicate-dead shape revives atomically with distinct canonical names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-status-dead-duplicates-'))
  try {
    const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
    const groups = [
      ['aev-notify-canary-claude', 4],
      ['bev-notify-canary-claude', 3],
      ['cev-notify-canary-claude', 3],
      ['dev-notify-canary-claude', 7],
    ]
    const admissions = []
    for (const [name, count] of groups) {
      for (let index = 0; index < count; index++) {
        const id = `fleet:${name}:${index}`
        store.upsertAgent({ id, friendly_name: name, labels: [], dead: true, metadata: { kind: 'claude' } })
        store.setAgentDaemonRoute(id, 'mini:testing')
        admissions.push({ id, create: false, friendly_name: name, runtime_kind: 'claude' })
      }
    }

    store.admitDaemonAgentStatusIdentities(admissions, 'mini:testing')

    const revived = store.getAgentsByIds(admissions.map(row => row.id))
    assert.equal(revived.length, 17)
    assert.equal(revived.every(row => row.dead === false && row.route_daemon_key === 'mini:testing'), true)
    assert.equal(new Set(revived.map(row => row.friendly_name)).size, 17)
    for (const [name] of groups) assert.equal(revived.filter(row => row.friendly_name === name).length, 1)
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('duplicate process names preserve distinct canonical names for existing live IDs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-status-duplicate-process-name-'))
  try {
    const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
    store.upsertAgent({ id: 'fleet:aev-1', friendly_name: 'aev-notify-canary', labels: [] })
    store.upsertAgent({ id: 'fleet:aev-2', friendly_name: 'zev-notify-canary', labels: [] })
    store.admitDaemonAgentStatusIdentities([
      { id: 'fleet:aev-1', create: false, friendly_name: 'aev-notify-canary', runtime_kind: 'claude' },
      { id: 'fleet:aev-2', create: false, friendly_name: 'aev-notify-canary', runtime_kind: 'claude' },
    ], 'mini:testing')
    assert.deepEqual(store.getAgentsByIds(['fleet:aev-1', 'fleet:aev-2']).map(row => row.friendly_name).sort(), [
      'aev-notify-canary', 'zev-notify-canary',
    ])
    store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('worker-backed FleetStoreClient admits and returns a live process identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tlda-status-worker-admission-'))
  const store = new FleetStoreClient(join(dir, 'fleet.db'), { taskDoc: false })
  try {
    await store.admitDaemonAgentStatusIdentities([{
      id: 'fleet:worker-live', create: true, friendly_name: 'worker-live', runtime_kind: 'codex',
    }], 'mini:testing')
    const routed = await store.getAgentsByDaemonKey('mini:testing')
    assert.deepEqual(routed.map(row => ({ id: row.id, name: row.friendly_name, route: row.route_daemon_key })), [
      { id: 'fleet:worker-live', name: 'worker-live', route: 'mini:testing' },
    ])
  } finally {
    await store.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('accepts only a newer complete batch owned by the socket daemon', () => {
  assert.deepEqual(validateDaemonAgentStatusBatch({
    message,
    daemonKey: 'mini:testing',
    bootId: 7,
    lastSequence: 1,
    agents: [agent, omittedAgent],
  }), {
    sequence: 2,
    results: [
      ...message.agents,
      { agent_id: 'fleet:omitted', status: 'hibernating', activity: 'unknown', tool: null },
    ],
  })

  assert.equal(validateDaemonAgentStatusBatch({
    message,
    daemonKey: 'mini:testing',
    bootId: 7,
    lastSequence: 2,
    agents: [agent],
  }), null)

  // An agent routed to another daemon is refused, but as a ROW: this daemon does
  // not get to report it awake, and the rest of the batch is unaffected. This
  // previously nulled the whole batch; the ownership boundary is what matters and
  // it is unchanged.
  const foreign = validateDaemonAgentStatusBatch({
    message,
    daemonKey: 'mini:testing',
    bootId: 7,
    lastSequence: 1,
    agents: [{ ...agent, route_daemon_key: 'mini:stable' }],
  })
  assert.deepEqual(foreign.results, [], 'the foreign-routed agent is not reported awake')
})

test('an empty complete batch hibernates every routed agent', () => {
  const empty = { ...message, agents: [] }
  assert.deepEqual(validateDaemonAgentStatusBatch({
    message: empty,
    daemonKey: 'mini:testing',
    bootId: 7,
    lastSequence: 1,
    agents: [agent, omittedAgent],
  }), {
    sequence: 2,
    results: [
      { agent_id: 'fleet:owned', status: 'hibernating', activity: 'unknown', tool: null },
      { agent_id: 'fleet:omitted', status: 'hibernating', activity: 'unknown', tool: null },
    ],
  })
})

test('activity rejects a stale generation from the same daemon boot', () => {
  const runtime = createAgentRuntimeStatusStore({ now: () => 100 })
  runtime.updateActivity('fleet:owned', 'thinking', {
    tool: null,
    atMs: 100,
    generation: { daemon_key: 'mini:testing', daemon_boot_id: 7, report_seq: 3 },
  })
  runtime.updateActivity('fleet:owned', 'idle', {
    tool: null,
    atMs: 101,
    generation: { daemon_key: 'mini:testing', daemon_boot_id: 7, report_seq: 2 },
  })
  assert.equal(runtime.evidenceFor('fleet:owned').activity, 'thinking')
})

test('a later batch cannot apply until the prior batch finishes', async () => {
  const chains = new Map()
  const events = []
  let releaseFirst
  const firstGate = new Promise(resolve => { releaseFirst = resolve })
  const first = applyDaemonAgentStatusBatch(chains, 'mini:testing', async () => {
    events.push('first-start')
    await firstGate
    events.push('first-end')
  })
  const second = applyDaemonAgentStatusBatch(chains, 'mini:testing', async () => {
    events.push('second-start')
  })

  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events, ['first-start'])
  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(events, ['first-start', 'first-end', 'second-start'])
  assert.equal(chains.size, 0)
})

test('an old boot queued after takeover has no side effects', async () => {
  const chains = new Map()
  const events = []
  const newSocket = { boot: 8 }
  const oldSocket = { boot: 7 }
  const activeSocket = newSocket
  let releaseNew
  const newGate = new Promise(resolve => { releaseNew = resolve })
  const current = applyDaemonAgentStatusBatch(chains, 'mini:testing', async () => {
    events.push('new-start')
    await newGate
    events.push('new-end')
  }, () => activeSocket === newSocket)
  const superseded = applyDaemonAgentStatusBatch(chains, 'mini:testing', async () => {
    events.push('old-applied')
  }, () => activeSocket === oldSocket)

  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events, ['new-start'])
  releaseNew()
  await Promise.all([current, superseded])
  assert.deepEqual(events, ['new-start', 'new-end'])
  assert.equal(chains.size, 0)
})

// THE COUNTERFACTUAL at the server boundary. Row-level checks used to `return
// null`, discarding every valid agent's status travelling in the same message.
test('one malformed row does not discard the valid awake and hibernating rows beside it', () => {
  const awake = { id: 'fleet:awake', route_daemon_key: 'mini:testing' }
  const sleeping = { id: 'fleet:sleeping', route_daemon_key: 'mini:testing' }
  const skipped = []
  const accepted = validateDaemonAgentStatusBatch({
    message: {
      ...message,
      agents: [
        { agent_id: 'fleet:awake', status: 'awake', activity: 'thinking', tool: null },
        { agent_id: 'fleet:nonsense', status: 'banana', activity: '', tool: null },
        { agent_id: 'fleet:sleeping', status: 'hibernating', activity: 'idle', tool: null },
      ],
    },
    daemonKey: 'mini:testing',
    bootId: 7,
    lastSequence: 1,
    agents: [awake, sleeping],
    onSkip: result => skipped.push(result?.agent_id),
  })

  assert.ok(accepted, 'the batch survives a malformed row')
  assert.equal(accepted.sequence, 2)
  assert.deepEqual(skipped, ['fleet:nonsense'])
  const byId = new Map(accepted.results.map(r => [r.agent_id, r]))
  assert.equal(byId.get('fleet:awake').status, 'awake')
  assert.equal(byId.get('fleet:sleeping').status, 'hibernating')
  assert.equal(byId.has('fleet:nonsense'), false)
})

test('a message from the wrong daemon boot is still rejected whole', () => {
  assert.equal(validateDaemonAgentStatusBatch({
    message, daemonKey: 'mini:testing', bootId: 9, lastSequence: 1, agents: [agent],
  }), null)
  assert.equal(validateDaemonAgentStatusBatch({
    message, daemonKey: 'mini:testing', bootId: 7, lastSequence: 2, agents: [agent],
  }), null, 'a replayed sequence is refused')
})

test('a cross-daemon identity claim is dropped as a row without taking the batch with it', () => {
  const mine = { id: 'fleet:mine', route_daemon_key: 'mini:testing' }
  const theirs = { id: 'fleet:theirs', route_daemon_key: 'mini:stable' }
  const skipped = []
  const planned = planDaemonAgentStatusBatch({
    message: {
      ...message,
      agents: [
        { agent_id: 'fleet:mine', status: 'awake', activity: 'idle', tool: null, identity: { friendly_name: 'mine', runtime_kind: 'codex' } },
        { agent_id: 'fleet:theirs', status: 'awake', activity: 'idle', tool: null, identity: { friendly_name: 'theirs', runtime_kind: 'codex' } },
      ],
    },
    daemonKey: 'mini:testing',
    bootId: 7,
    lastSequence: 1,
    routedAgents: [mine],
    knownAgents: [mine, theirs],
    onSkip: result => skipped.push(result?.agent_id),
  })

  assert.ok(planned)
  assert.deepEqual(skipped, ['fleet:theirs'], 'the claim is refused')
  assert.deepEqual(planned.admissions.map(a => a.id), ['fleet:mine'])
  assert.equal(planned.results.some(r => r.agent_id === 'fleet:theirs'), false)
})
