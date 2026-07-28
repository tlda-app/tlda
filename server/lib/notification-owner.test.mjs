import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FleetStore } from './fleet-store.mjs'
import {
  NotificationOwnerRegistry,
  notificationRecipients,
  readNotificationFlushIfOwner,
} from './notification-owner.mjs'

function notificationSocket({ sessionId = 'session-1', startedAt, instanceId }) {
  return {
    readyState: 1,
    _notificationSubscriber: true,
    _notificationSessionId: sessionId,
    _notificationStartedAt: startedAt,
    _notificationInstanceId: instanceId,
  }
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-notification-owner-'))
  const store = new FleetStore(join(dir, 'fleet.db'), { taskDoc: false })
  try {
    store.db.prepare(`
      INSERT INTO agents (id, registered_at, last_seen, dead, human)
      VALUES ('fleet:agent', '2026-07-28T00:00:00.000Z', '2026-07-28T00:00:00.000Z', 0, 0)
    `).run()
    store.db.prepare(`
      INSERT INTO agent_seats (agent_id, session_id, kind, model, cwd, created_at)
      VALUES ('fleet:agent', 'session-1', 'codex', 'test', '/tmp', '2026-07-28T00:00:00.000Z')
    `).run()
    store.db.prepare(`
      INSERT INTO agent_current_seats
        (agent_id, session_id, machine_id, env_name, daemon_key, activated_at)
      VALUES ('fleet:agent', 'session-1', 'mini', 'testing', 'mini:testing', '2026-07-28T00:00:00.000Z')
    `).run()
    await run(store)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('notification ownership survives overlap, handoff, socket absence, and restart', async () => {
  await withStore(async store => {
    const owners = new NotificationOwnerRegistry(store)
    const oldSocket = notificationSocket({ startedAt: 100, instanceId: 'old' })
    const newSocket = notificationSocket({ startedAt: 200, instanceId: 'new' })

    assert.equal(await owners.bind(oldSocket, 'fleet:agent', 'session-1'), true)
    assert.equal(await owners.bind(newSocket, 'fleet:agent', 'session-1'), true)
    assert.equal(owners.socketFor('fleet:agent'), newSocket)
    assert.equal(owners.isOwner(oldSocket, 'fleet:agent', 'session-1', 100, 'old'), false)
    assert.equal(owners.isOwner(newSocket, 'fleet:agent', 'session-1', 200, 'new'), true)

    owners.clear(newSocket)
    assert.equal(owners.socketFor('fleet:agent'), null)
    assert.equal(store.getNotificationOwnerClaim('fleet:agent', 'session-1').instance_id, 'new')

    const afterRestart = new NotificationOwnerRegistry(store)
    const staleFirst = notificationSocket({ startedAt: 100, instanceId: 'old' })
    assert.equal(await afterRestart.bind(staleFirst, 'fleet:agent', 'session-1'), false)
    assert.equal(afterRestart.socketFor('fleet:agent'), null)
    const winnerReturns = notificationSocket({ startedAt: 200, instanceId: 'new' })
    assert.equal(await afterRestart.bind(winnerReturns, 'fleet:agent', 'session-1'), true)
    assert.equal(afterRestart.socketFor('fleet:agent'), winnerReturns)
  })
})

test('equal-start ownership uses instance id as deterministic tie-break', async () => {
  await withStore(async store => {
    const owners = new NotificationOwnerRegistry(store)
    const lower = notificationSocket({ startedAt: 100, instanceId: 'aaa' })
    const higher = notificationSocket({ startedAt: 100, instanceId: 'bbb' })
    assert.equal(await owners.bind(lower, 'fleet:agent', 'session-1'), true)
    assert.equal(await owners.bind(higher, 'fleet:agent', 'session-1'), true)
    assert.equal(owners.socketFor('fleet:agent'), higher)
    assert.equal(await owners.bind(lower, 'fleet:agent', 'session-1'), false)
  })
})

test('notification ownership resolves an omitted client session from the current seat', async () => {
  await withStore(async store => {
    const owners = new NotificationOwnerRegistry(store)
    const socket = notificationSocket({ sessionId: null, startedAt: 100, instanceId: 'current' })

    assert.equal(await owners.bind(socket, 'fleet:agent', null), true)
    assert.equal(socket._notificationSessionId, 'session-1')
    assert.equal(owners.socketFor('fleet:agent'), socket)
    assert.equal(owners.isOwner(socket, 'fleet:agent', 'session-1', 100, 'current'), true)
  })
})

test('superseding the owner while unread is in flight empties the old flush', async () => {
  await withStore(async store => {
    const owners = new NotificationOwnerRegistry(store)
    const oldSocket = notificationSocket({ startedAt: 100, instanceId: 'old' })
    const newSocket = notificationSocket({ startedAt: 200, instanceId: 'new' })
    await owners.bind(oldSocket, 'fleet:agent', 'session-1')
    const unreadGate = deferred()

    const oldFlush = readNotificationFlushIfOwner({
      registry: owners,
      ws: oldSocket,
      agentId: 'fleet:agent',
      sessionId: 'session-1',
      startedAt: 100,
      instanceId: 'old',
      read: () => unreadGate.promise,
      empty: [],
    })

    await owners.bind(newSocket, 'fleet:agent', 'session-1')
    unreadGate.resolve([{ id: 1, unread: true }])
    assert.deepEqual(await oldFlush, [])
    assert.equal(owners.socketFor('fleet:agent'), newSocket)
  })
})

test('notification routing includes fired timers and each wiretap recipient', () => {
  assert.deepEqual(
    [...notificationRecipients({
      event: 'event-update',
      data: { type: 'timer', to: 'fleet:agent', metadata: { state: 'fired' } },
    })],
    ['fleet:agent'],
  )
  assert.deepEqual(
    [...notificationRecipients({
      event: 'fleet-event',
      data: {
        type: 'chat',
        to: 'fleet:agent',
        metadata: { wiretap_cc: ['fleet:watch-1', 'fleet:watch-2'] },
      },
    })],
    ['fleet:agent', 'fleet:watch-1', 'fleet:watch-2'],
  )
  assert.equal(notificationRecipients({
    event: 'event-update',
    data: { type: 'timer', to: 'fleet:agent', metadata: { state: 'pending' } },
  }), null)
})
