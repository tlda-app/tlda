import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createFleetRouter } from '../server/routes/fleet.mjs'
import { FleetStore } from '../server/lib/fleet-store.mjs'

function makeStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'fleet-unread-retract-'))
  const store = new FleetStore(path.join(dir, 'fleet.db'))
  return {
    store,
    cleanup() {
      try { store.close() } catch {
        // Best-effort test cleanup.
      }
      try { rmSync(dir, { recursive: true, force: true }) } catch {
        // Best-effort temp cleanup.
      }
    },
  }
}

function task(id, agent = 'fleet:target') {
  return {
    id,
    agent,
    description: `Task ${id}`,
    message: `Task ${id}`,
    delegated_by: 'fleet:sender',
    delegated_at: new Date().toISOString(),
    status: 'pending',
    acknowledged: false,
  }
}

async function withRetractServer({ exposedAgent = null } = {}, fn) {
  const { store, cleanup } = makeStore()
  const app = express()
  let stateBroadcasts = 0
  app.use(express.json())
  app.use(createFleetRouter({
    fleetStore: store,
    broadcastEvent: () => {},
    broadcastState: () => { stateBroadcasts++ },
    clearEphemeralState: () => {},
    suppressEchoFor: () => {},
    sendRpc: async () => ({}),
    resolveRpc: () => ({ via: 'none', code: 503, error: 'unused' }),
    resolveSpawnTarget: null,
    hasOpenFleetSocketForAgent: agentId => agentId === exposedAgent,
  }))
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn({ base: `http://127.0.0.1:${port}`, store, getStateBroadcasts: () => stateBroadcasts })
  } finally {
    await new Promise(resolve => server.close(resolve))
    cleanup()
  }
}

async function postRetract(base, body) {
  const res = await fetch(`${base}/api/retract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

test('retract before recipient-facing delivery removes unread delegate delivery', async () => {
  const { store, cleanup } = makeStore()
  try {
    const t = task('task-pre')
    store.upsertTask(t)
    const event = await store.delegate('fleet:sender', t.agent, t.id, t.description, {})

    assert.equal(store.getUnread(t.agent).length, 1)
    assert.equal(store.getTaskByAgent(t.agent).id, t.id)

    const result = store.retractTask(t.id)

    assert.equal(result.mode, 'removed_unread')
    assert.equal(result.unread_removed, true)
    assert.equal(result.event_id, event.id)
    assert.equal(store.getUnread(t.agent).length, 0)
    assert.equal(store.getTaskByAgent(t.agent), null)
    assert.equal(store.getTask(t.id), null)

    const retractedEvent = store.getEventById(event.id)
    assert.equal(retractedEvent.metadata.retracted, true)
    assert.equal(retractedEvent.metadata.retracted_before_delivery, true)
  } finally {
    cleanup()
  }
})

test('HTTP retract after recipient channel exposure marks retracted without consuming unread', async () => {
  await withRetractServer({ exposedAgent: 'fleet:target' }, async ({ base, store, getStateBroadcasts }) => {
    const t = task('task-http-channel')
    store.upsertTask(t)
    await store.delegate('fleet:sender', t.agent, t.id, t.description, {})

    const res = await postRetract(base, { agent: t.agent, task_id: t.id })

    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
    assert.equal(res.json.mode, 'marked_retracted')
    assert.equal(res.json.unread_removed, false)
    assert.equal(store.getTaskByAgent(t.agent), null)
    assert.equal(store.getTask(t.id).status, 'retracted')
    assert.equal(getStateBroadcasts(), 1)

    const unread = store.getUnread(t.agent)
    assert.equal(unread.length, 1)
    assert.equal(unread[0].task_id, t.id)
    assert.equal(unread[0].metadata.retracted_after_delivery, true)
  })
})

test('retract after my_task delivery preserves history and marks task retracted', async () => {
  const { store, cleanup } = makeStore()
  try {
    const t = task('task-post-read')
    store.upsertTask(t)
    const event = await store.delegate('fleet:sender', t.agent, t.id, t.description, {})
    store.markRead(t.agent)

    const result = store.retractTask(t.id)

    assert.equal(result.mode, 'marked_retracted')
    assert.equal(result.unread_removed, false)
    assert.equal(store.getTaskByAgent(t.agent), null)

    const storedTask = store.getTask(t.id)
    assert.equal(storedTask.status, 'retracted')
    assert.equal(storedTask.metadata.retracted, true)
    assert.equal(storedTask.metadata.retracted_after_delivery, true)

    const retractedEvent = store.getEventById(event.id)
    assert.equal(retractedEvent.metadata.retracted, true)
    assert.equal(retractedEvent.metadata.retracted_after_delivery, true)
  } finally {
    cleanup()
  }
})

test('retract after channel exposure does not consume unread mailbox item', async () => {
  const { store, cleanup } = makeStore()
  try {
    const t = task('task-post-channel')
    store.upsertTask(t)
    await store.delegate('fleet:sender', t.agent, t.id, t.description, {})

    const result = store.retractTask(t.id, { recipientExposed: true })

    assert.equal(result.mode, 'marked_retracted')
    assert.equal(result.unread_removed, false)
    assert.equal(store.getTaskByAgent(t.agent), null)

    const unread = store.getUnread(t.agent)
    assert.equal(unread.length, 1)
    assert.equal(unread[0].task_id, t.id)
    assert.equal(unread[0].metadata.retracted, true)
    assert.equal(unread[0].metadata.retracted_after_delivery, true)
  } finally {
    cleanup()
  }
})
