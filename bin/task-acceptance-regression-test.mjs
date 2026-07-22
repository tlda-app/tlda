import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { acceptTaskResponsibility } from '../server/lib/task-acceptance.mjs'
import { FleetStore } from '../server/lib/fleet-store.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fingerprint = {
  agent_id: 'fleet:worker',
  session_id: 'session-1',
  daemon_key: 'machine::env',
  terminal_capability: 'cap-1',
  activated_at: '2026-07-22T12:00:00.000Z',
}

function fixture(overrides = {}) {
  let task = {
    id: 'task-1', agent: 'fleet:worker', status: 'pending', acknowledged: false,
    description: 'Do the work', metadata: {}, ...overrides.task,
  }
  let seat = overrides.seat === undefined ? { ...fingerprint } : overrides.seat
  const events = []
  return {
    get task() { return task },
    events,
    store: {
      getTask: id => id === task.id ? structuredClone(task) : null,
      getCurrentAgentSeat: agentId => agentId === task.agent && seat ? structuredClone(seat) : null,
      upsertTask: next => { task = structuredClone(next) },
      acceptTaskAtomically: async ({ task: accepted, fingerprint: fp, operationId, acceptedAt }) => {
        const event = { id: 71, agentId: accepted.agent, taskId: accepted.id, status: 'working' }
        task = {
          ...accepted, status: 'working', acknowledged: true,
          metadata: { ...(accepted.metadata || {}), task_acceptance: {
            operation_id: operationId, accepted_at: acceptedAt, fingerprint: structuredClone(fp), event_id: 71,
          } },
        }
        events.push(event)
        return { task: structuredClone(task), event }
      },
    },
    setSeat(next) { seat = next },
  }
}

test('inbox/read presentation does not accept a pending task', () => {
  const f = fixture()
  const presented = structuredClone(f.task)
  assert.equal(presented.status, 'pending')
  assert.equal(presented.acknowledged, false)
  assert.equal(presented.metadata.task_acceptance, undefined)
})

test('explicit acceptance persists exact authority and emits one transition', async () => {
  const f = fixture()
  const result = await acceptTaskResponsibility({
    fleetStore: f.store, taskId: 'task-1', callerAgentId: 'fleet:worker',
    callerSessionId: 'session-1', operationId: 'accept-op-1', now: '2026-07-22T12:01:00.000Z',
  })
  assert.equal(result.idempotent, false)
  assert.equal(f.task.status, 'working')
  assert.equal(f.task.acknowledged, true)
  assert.deepEqual(f.task.metadata.task_acceptance.fingerprint, fingerprint)
  assert.equal(f.task.metadata.task_acceptance.operation_id, 'accept-op-1')
  assert.equal(f.task.metadata.task_acceptance.accepted_at, '2026-07-22T12:01:00.000Z')
  assert.equal(f.events.length, 1)
})

test('same or different retry returns existing acceptance without overwriting or another event', async () => {
  const f = fixture()
  const args = { fleetStore: f.store, taskId: 'task-1', callerAgentId: 'fleet:worker', callerSessionId: 'session-1' }
  const first = await acceptTaskResponsibility({ ...args, operationId: 'accept-op-1', now: '2026-07-22T12:01:00.000Z' })
  const same = await acceptTaskResponsibility({ ...args, operationId: 'accept-op-1', now: '2026-07-22T12:02:00.000Z' })
  const different = await acceptTaskResponsibility({ ...args, operationId: 'accept-op-2', now: '2026-07-22T12:03:00.000Z' })
  assert.equal(first.idempotent, false)
  assert.equal(same.idempotent, true)
  assert.equal(different.idempotent, true)
  assert.equal(f.task.metadata.task_acceptance.operation_id, 'accept-op-1')
  assert.equal(f.task.metadata.task_acceptance.accepted_at, '2026-07-22T12:01:00.000Z')
  assert.equal(f.events.length, 1)
})

for (const [name, mutate, pattern] of [
  ['wrong assignee', f => ({ callerAgentId: 'fleet:other' }), /assigned/i],
  ['missing caller session', f => ({ callerSessionId: null }), /session/i],
  ['missing durable seat', f => { f.setSeat(null); return {} }, /seat/i],
  ['stale session', f => ({ callerSessionId: 'session-old' }), /session/i],
  ['blocked task', f => { f.store.upsertTask({ ...f.task, status: 'blocked' }); return {} }, /pending/i],
  ['done task', f => { f.store.upsertTask({ ...f.task, status: 'done' }); return {} }, /active|pending/i],
]) test(`rejects ${name} without mutation`, async () => {
  const f = fixture()
  const extra = mutate(f)
  await assert.rejects(() => acceptTaskResponsibility({
    fleetStore: f.store, taskId: 'task-1', callerAgentId: 'fleet:worker', callerSessionId: 'session-1',
    operationId: 'accept-op-1', ...extra,
  }), pattern)
  assert.equal(f.events.length, 0)
  assert.notEqual(f.task.metadata?.task_acceptance?.accepted_at, '2026-07-22T12:01:00.000Z')
})

test('later seat rotation preserves the historical acceptance for the assigned agent', async () => {
  const f = fixture()
  const args = { fleetStore: f.store, taskId: 'task-1', callerAgentId: 'fleet:worker', callerSessionId: 'session-1' }
  await acceptTaskResponsibility({ ...args, operationId: 'accept-op-1' })
  f.setSeat({ ...fingerprint, terminal_capability: 'cap-2' })
  const retried = await acceptTaskResponsibility({ ...args, callerSessionId: 'session-1', operationId: 'accept-op-2' })
  assert.equal(retried.idempotent, true)
  assert.equal(f.events.length, 1)
})

test('only the acceptance authority mints acknowledged acceptance state or metadata', () => {
  const roots = ['server', 'mcp-server']
  const offenders = []
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(?:mjs|js|ts)$/.test(entry.name) &&
        !full.endsWith('server/lib/task-acceptance.mjs') &&
        !full.endsWith('server/lib/fleet-store.mjs')) {
        const source = fs.readFileSync(full, 'utf8')
        if (/task_acceptance\s*:|acknowledged\s*:\s*true|acknowledged\s*=\s*1|UPDATE\s+tasks\s+SET\s+acknowledged/i.test(source)) {
          offenders.push(path.relative(ROOT, full))
        }
      }
    }
  }
  for (const root of roots) walk(path.join(ROOT, root))
  assert.deepEqual(offenders, [])
})

function realFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-task-acceptance-'))
  const store = new FleetStore(path.join(dir, 'fleet.db'), { taskDoc: false })
  for (const [id, name] of [['fleet:worker', 'worker'], ['fleet:successor', 'successor']]) {
    store.upsertAgent({
      id, friendly_name: name, labels: [], registered_at: fingerprint.activated_at,
      last_seen: fingerprint.activated_at, dead: false, human: false, is_manager: false,
      metadata: { kind: 'codex', model: 'test' },
    })
  }
  store.insertAgentSeat({
    agent_id: fingerprint.agent_id, session_id: fingerprint.session_id,
    resume_id: fingerprint.session_id, kind: 'codex', model: 'test', cwd: dir,
    created_source: 'task-acceptance-test',
  }, { now: fingerprint.activated_at })
  store.activateAgentSeat({
    agentId: fingerprint.agent_id, sessionId: fingerprint.session_id,
    machineId: 'machine', envName: 'env', daemonKey: fingerprint.daemon_key,
    terminalCapability: fingerprint.terminal_capability, now: fingerprint.activated_at,
  })
  store.upsertTask({
    id: 'task-real', agent: fingerprint.agent_id, description: 'real task',
    delegated_at: fingerprint.activated_at, status: 'pending', acknowledged: false, metadata: {},
  })
  return {
    store, dir,
    close() { store.close(); fs.rmSync(dir, { recursive: true, force: true }) },
  }
}

async function acceptReal(store, operationId = 'real-op') {
  return acceptTaskResponsibility({
    fleetStore: store, taskId: 'task-real', callerAgentId: fingerprint.agent_id,
    callerSessionId: fingerprint.session_id, operationId,
    now: '2026-07-22T12:01:00.000Z',
  })
}

test('real store commits task, operation, fingerprint, and event linkage atomically', async () => {
  const f = realFixture()
  try {
    const result = await acceptReal(f.store)
    const task = f.store.getTask('task-real')
    const event = f.store.db.prepare("SELECT * FROM events WHERE task_id = ? AND type = 'task_update'").get('task-real')
    assert.equal(result.idempotent, false)
    assert.equal(task.metadata.task_acceptance.event_id, event.id)
    assert.equal(task.metadata.task_acceptance.operation_id, 'real-op')
    assert.deepEqual(task.metadata.task_acceptance.fingerprint, fingerprint)
    const retry = await acceptReal(f.store)
    assert.equal(retry.idempotent, true)
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'task_update'").get('task-real').n, 1)
  } finally { f.close() }
})

for (const [name, trigger] of [
  ['event insert', "CREATE TRIGGER fail_accept_event BEFORE INSERT ON events WHEN NEW.type = 'task_update' BEGIN SELECT RAISE(ABORT, 'injected event failure'); END"],
  ['task update', "CREATE TRIGGER fail_accept_update BEFORE UPDATE OF acknowledged ON tasks BEGIN SELECT RAISE(ABORT, 'injected update failure'); END"],
  ['transaction completion', "CREATE TRIGGER fail_accept_commit AFTER UPDATE OF acknowledged ON tasks BEGIN SELECT RAISE(ROLLBACK, 'injected completion failure'); END"],
]) test(`real store rolls back both sides on injected ${name} failure`, async () => {
  const f = realFixture()
  try {
    f.store.db.exec(trigger)
    await assert.rejects(() => acceptReal(f.store), /injected/)
    const task = f.store.getTask('task-real')
    assert.equal(task.status, 'pending')
    assert.equal(task.acknowledged, false)
    assert.equal(task.metadata?.task_acceptance, undefined)
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'task_update'").get('task-real').n, 0)
  } finally { f.close() }
})

test('seat rotation between initial read and guarded commit rolls back the event', async () => {
  const f = realFixture()
  try {
    const atomic = f.store.acceptTaskAtomically.bind(f.store)
    f.store.acceptTaskAtomically = async args => {
      f.store.activateAgentSeat({
        agentId: fingerprint.agent_id, sessionId: fingerprint.session_id,
        machineId: 'machine', envName: 'env', daemonKey: fingerprint.daemon_key,
        terminalCapability: 'cap-rotated', now: '2026-07-22T12:00:30.000Z',
      })
      return atomic(args)
    }
    await assert.rejects(() => acceptReal(f.store), /expected 1 change/)
    assert.equal(f.store.getTask('task-real').status, 'pending')
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'task_update'").get('task-real').n, 0)
  } finally { f.close() }
})

test('ownership transfer resets accepted work and requires successor acceptance', async () => {
  const f = realFixture()
  try {
    await acceptReal(f.store)
    assert.equal(f.store.transferTaskOwnership('task-real', 'fleet:successor'), 1)
    const task = f.store.getTask('task-real')
    assert.equal(task.agent, 'fleet:successor')
    assert.equal(task.status, 'pending')
    assert.equal(task.acknowledged, false)
    assert.equal(task.metadata.task_acceptance, undefined)
  } finally { f.close() }
})

test('bulk identity transfer applies the same acceptance reset', async () => {
  const f = realFixture()
  try {
    await acceptReal(f.store)
    assert.equal(f.store.transferTasks('fleet:worker', 'fleet:successor'), 1)
    const task = f.store.getTask('task-real')
    assert.equal(task.agent, 'fleet:successor')
    assert.equal(task.status, 'pending')
    assert.equal(task.acknowledged, false)
    assert.equal(task.metadata.task_acceptance, undefined)
  } finally { f.close() }
})

for (const [transferName, transfer] of [
  ['direct', store => store.transferTaskOwnership('task-real', 'fleet:successor')],
  ['bulk', store => store.transferTasks('fleet:worker', 'fleet:successor')],
]) {
  for (const [metadataName, metadata] of [
    ['null', null],
    ['populated', { trace_id: 'trace-1', native: false, nested: { keep: true } }],
  ]) test(`${transferName} transfer preserves unaccepted ${metadataName} metadata and state exactly`, () => {
    const f = realFixture()
    try {
      f.store.upsertTask({
        ...f.store.getTask('task-real'), status: 'blocked', acknowledged: false,
        blockedBy: ['dependency'], metadata,
      })
      const before = f.store.db.prepare('SELECT status, acknowledged, metadata FROM tasks WHERE id = ?').get('task-real')
      assert.equal(transfer(f.store), 1)
      const after = f.store.db.prepare('SELECT agent, status, acknowledged, metadata FROM tasks WHERE id = ?').get('task-real')
      assert.equal(after.agent, 'fleet:successor')
      assert.equal(after.status, before.status)
      assert.equal(after.acknowledged, before.acknowledged)
      assert.equal(after.metadata, before.metadata)
    } finally { f.close() }
  })
}

test('post-commit listener failure leaves a complete idempotent acceptance', async () => {
  const f = realFixture()
  try {
    f.store.onEvent(() => { throw new Error('injected notification failure') })
    const first = await acceptReal(f.store)
    const retry = await acceptReal(f.store, 'later-op')
    assert.equal(first.idempotent, true)
    assert.equal(retry.idempotent, true)
    assert.equal(f.store.getTask('task-real').metadata.task_acceptance.event_id, first.event_id)
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND type = 'task_update'").get('task-real').n, 1)
  } finally { f.close() }
})
