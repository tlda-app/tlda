#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { shouldSkipOriginatedEvent, shouldSuppressRecentContent } from '../mcp-server/lib/timer-channel-delivery.mjs'
import { timerSetEventIdFromAck, timerSetMessage } from '../mcp-server/lib/timer-protocol.mjs'
import { FleetStore } from '../server/lib/fleet-store.mjs'
import { resolveTimerParticipants, timerDeliveryFailureResult, timerTerminalInputFailureResult } from '../server/lib/timer-routing.mjs'
import { ServerTimerScheduler } from '../server/lib/timer-scheduler.mjs'

const agents = new Map([
  ['fresh-todd-continuity', { id: 'fleet:0ae838ad' }],
  ['fleet:0ae838ad', { id: 'fleet:0ae838ad' }],
  ['appchief-fml', { id: 'fleet:f124b5f3' }],
])
const findAgent = key => agents.get(key) || null

{
  const resolved = resolveTimerParticipants({
    agent: 'fresh-todd-continuity',
    findAgent,
    fallbackOwner: 'fleet:skip',
  })
  assert.deepEqual(resolved, {
    from: 'fleet:0ae838ad',
    to: 'fleet:0ae838ad',
  })
}

{
  const resolved = resolveTimerParticipants({
    agent: 'fresh-todd-continuity',
    toAgent: 'appchief-fml',
    findAgent,
    fallbackOwner: 'fleet:skip',
  })
  assert.deepEqual(resolved, {
    from: 'fleet:0ae838ad',
    to: 'fleet:f124b5f3',
  })
}

{
  const msg = timerSetMessage({
    agentId: 'fleet:0ae838ad',
    message: 'check appchief',
    fireAt: '2026-07-20T08:20:00.000Z',
  })
  assert.deepEqual(msg, {
    agent: 'fleet:0ae838ad',
    to: 'fleet:0ae838ad',
    message: 'check appchief',
    fire_at: '2026-07-20T08:20:00.000Z',
  })
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-timer-atomic-'))
  const dbPath = path.join(dir, 'fleet.db')
  const storeA = new FleetStore(dbPath, { taskDoc: false })
  let storeB = null
  try {
    const owner = 'fleet:0ae838ad'
    const event = await storeA._insertEventRecord({
      type: 'timer',
      timestamp: '2026-07-20T08:20:00.000Z',
      from: owner,
      to: owner,
      text: '⏱ concurrent check',
      metadata: { pending: true, fire_at: '2026-07-20T08:21:00.000Z', message: 'concurrent check' },
      unread: false,
    }, { notify: false })
    storeA.markEventUnread(event.id, owner)
    storeA.markEventRead(event.id, owner)
    storeB = new FleetStore(dbPath, { taskDoc: false })
    const patch = {
      pending: false,
      state: 'fired',
      timer_fire_notified_to: owner,
      timer_fire_notified_at: '2026-07-20T08:21:00.000Z',
    }

    const claims = await Promise.all([
      Promise.resolve().then(() => storeA.claimTimerTerminal(event.id, { to: owner, metadataPatch: patch, unread: true })),
      Promise.resolve().then(() => storeB.claimTimerTerminal(event.id, { to: owner, metadataPatch: patch, unread: true })),
    ])
    assert.equal(claims.filter(Boolean).length, 1)
    assert.equal(storeA.db.prepare('SELECT read FROM unread WHERE event_id = ? AND to_id = ?').get(event.id, owner).read, 0)
  } finally {
    storeB?.close()
    storeA.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

{
  const originated = new Set([1445004])
  assert.equal(shouldSkipOriginatedEvent({
    eventId: 1445004,
    originatedEventIds: originated,
    isTimerFire: true,
  }), false)
  assert.equal(originated.has(1445004), true)
  assert.equal(shouldSkipOriginatedEvent({
    eventId: 1445004,
    originatedEventIds: originated,
    isTimerFire: false,
  }), true)
  assert.equal(originated.has(1445004), false)
}

{
  assert.equal(shouldSuppressRecentContent({
    isTimerFire: true,
    content: '📬 Available timer: same message',
    lastContent: '📬 Available timer: same message',
    lastTs: 1000,
    now: 2000,
  }), false)
  assert.equal(shouldSuppressRecentContent({
    isTimerFire: false,
    content: '📬 Available message: same message',
    lastContent: '📬 Available message: same message',
    lastTs: 1000,
    now: 2000,
  }), true)
}

{
  assert.deepEqual(timerDeliveryFailureResult({
    state: 'fired',
    eventId: 1445005,
    error: new Error('database is locked'),
  }), {
    ok: false,
    error: 'timer fired delivery for event 1445005 failed: database is locked',
  })
}

{
  assert.deepEqual(timerTerminalInputFailureResult({
    state: 'fired',
    eventId: null,
  }), {
    ok: false,
    error: 'timer fired requires event_id',
  })
  assert.deepEqual(timerTerminalInputFailureResult({
    state: 'fired',
    eventId: 1445008,
  }), {
    ok: false,
    error: 'timer fired event 1445008 not found',
  })
}

{
  assert.equal(timerSetEventIdFromAck({ ok: true, id: 1445006 }), 1445006)
  assert.throws(() => timerSetEventIdFromAck({ ok: false, error: 'db down' }), /db down/)
  assert.throws(() => timerSetEventIdFromAck({ ok: true }), /missing event id/)
}

async function insertPendingTimer(store, { owner, fireAt, message = 'server scheduled timer' }) {
  return store._insertEventRecord({
    type: 'timer',
    timestamp: '2026-07-20T08:20:00.000Z',
    from: owner,
    to: owner,
    text: `⏱ ${message}`,
    metadata: { pending: true, fire_at: fireAt, message },
    unread: false,
  }, { notify: false })
}

function createSchedulerHarness(nowMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-server-timer-'))
  const store = new FleetStore(path.join(dir, 'fleet.db'), { taskDoc: false })
  const broadcasts = []
  const scheduled = []
  let now = nowMs
  const scheduler = new ServerTimerScheduler({
    store,
    broadcast: (type, data) => broadcasts.push({ type, data }),
    now: () => now,
    setTimeoutFn: (fn, delay) => {
      const handle = { fn, delay, cleared: false, unref() {} }
      scheduled.push(handle)
      return handle
    },
    clearTimeoutFn: handle => { handle.cleared = true },
  })
  return {
    store,
    scheduler,
    broadcasts,
    scheduled,
    setNow: value => { now = value },
    close: () => {
      store.close()
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

{
  const owner = 'fleet:0ae838ad'
  const h = createSchedulerHarness(Date.parse('2026-07-20T08:20:00.000Z'))
  try {
    const event = await insertPendingTimer(h.store, {
      owner,
      fireAt: '2026-07-20T08:20:05.000Z',
      message: 'process may exit',
    })
    await h.scheduler.start()
    assert.equal(h.broadcasts.length, 0)
    assert.equal(h.scheduled.length, 1)
    h.setNow(Date.parse('2026-07-20T08:20:05.000Z'))
    await h.scheduled[0].fn()
    assert.equal(h.broadcasts.length, 1)
    assert.equal(h.store.db.prepare('SELECT read FROM unread WHERE event_id = ? AND to_id = ?').get(event.id, owner).read, 0)
  } finally {
    h.close()
  }
}

{
  const h = createSchedulerHarness(Date.parse('2026-07-20T08:20:00.000Z'))
  try {
    await insertPendingTimer(h.store, {
      owner: 'fleet:0ae838ad',
      fireAt: '2026-07-20T08:21:00.000Z',
      message: 'future restart',
    })
    await h.scheduler.start()
    assert.equal(h.broadcasts.length, 0)
    assert.equal(h.scheduled.length, 1)
    assert.equal(h.scheduled[0].delay, 60_000)
  } finally {
    h.close()
  }
}

{
  const h = createSchedulerHarness(Date.parse('2026-07-20T08:21:00.000Z'))
  try {
    await insertPendingTimer(h.store, {
      owner: 'fleet:0ae838ad',
      fireAt: '2026-07-20T08:20:00.000Z',
      message: 'overdue recovery',
    })
    await h.scheduler.start()
    assert.equal(h.broadcasts.length, 1)
    assert.equal(h.store.listPendingTimerEvents().length, 0)
  } finally {
    h.close()
  }
}

{
  const owner = 'fleet:0ae838ad'
  const h = createSchedulerHarness(Date.parse('2026-07-20T08:20:05.000Z'))
  try {
    const event = await insertPendingTimer(h.store, {
      owner,
      fireAt: '2026-07-20T08:20:05.000Z',
      message: 'duplicate callback',
    })
    assert.equal((await h.scheduler.fire(event.id)).notified, true)
    assert.equal((await h.scheduler.fire(event.id)).duplicate, true)
    assert.equal(h.broadcasts.length, 1)
  } finally {
    h.close()
  }
}

{
  const owner = 'fleet:0ae838ad'
  const h = createSchedulerHarness(Date.parse('2026-07-20T08:20:00.000Z'))
  try {
    const event = await insertPendingTimer(h.store, {
      owner,
      fireAt: '2026-07-20T08:21:00.000Z',
      message: 'cancel before fire',
    })
    assert.equal((await h.scheduler.cancel(event.id)).ok, true)
    await h.scheduler.start()
    h.setNow(Date.parse('2026-07-20T08:21:00.000Z'))
    await h.scheduler.refresh()
    assert.equal(h.broadcasts.filter(entry => entry.data.metadata_patch?.state === 'fired').length, 0)
    assert.equal(h.store.db.prepare('SELECT * FROM unread WHERE event_id = ? AND to_id = ?').get(event.id, owner), undefined)
  } finally {
    h.close()
  }
}

{
  const h = createSchedulerHarness(Date.parse('2026-07-20T08:20:05.000Z'))
  try {
    await insertPendingTimer(h.store, {
      owner: 'fleet:0ae838ad',
      fireAt: '2026-07-20T08:20:05.000Z',
      message: 'same time 1',
    })
    await insertPendingTimer(h.store, {
      owner: 'fleet:0ae838ad',
      fireAt: '2026-07-20T08:20:05.000Z',
      message: 'same time 2',
    })
    await h.scheduler.start()
    assert.equal(h.broadcasts.length, 2)
  } finally {
    h.close()
  }
}

console.log('timer routing regression tests passed')
