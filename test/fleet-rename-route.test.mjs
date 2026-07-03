import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createFleetRouter } from '../server/routes/fleet.mjs'
import { FleetStore } from '../server/lib/fleet-store.mjs'
import { parseFilter } from '../shared/fleet-labels.mjs'

async function withRenameServer(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fleet-rename-route-'))
  const store = new FleetStore(path.join(dir, 'fleet.db'))
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
  }))
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await fn({ base: `http://127.0.0.1:${port}`, store, getStateBroadcasts: () => stateBroadcasts })
  } finally {
    await new Promise(resolve => server.close(resolve))
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

async function rename(base, body) {
  const res = await fetch(`${base}/api/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

test('/api/rename syncs FleetStore cache and live registry and emits a rename event', async () => {
  await withRenameServer(async ({ base, store, getStateBroadcasts }) => {
    const events = []
    store.onEvent(event => events.push(event))
    store.upsertAgent({ id: 'fleet:a', friendly_name: 'alpha', labels: ['reviewers'], dead: false })
    assert.equal(store.findAgent('alpha')?.id, 'fleet:a')
    assert.equal(store.resolveChatRecipients(parseFilter('alpha'), { filter: 'alpha' })[0], 'fleet:a')
    assert.equal(store.getAgentNameMap()['fleet:a'], 'alpha')

    const res = await rename(base, { agent: 'alpha', name: 'bravo' })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json, { ok: true, agent: 'fleet:a', name: 'bravo' })

    assert.equal(store.findAgent('alpha'), null)
    assert.equal(store.findAgent('bravo')?.id, 'fleet:a')
    assert.deepEqual(store.resolveChatRecipients(parseFilter('alpha'), { filter: 'alpha' }), [])
    assert.deepEqual(store.resolveChatRecipients(parseFilter('bravo'), { filter: 'bravo' }), ['fleet:a'])
    assert.equal(store.getAgentNameMap()['fleet:a'], 'bravo')
    assert.equal(getStateBroadcasts(), 1)
    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'lifecycle')
    assert.equal(events[0].agent_id, 'fleet:a')
    assert.equal(events[0].metadata.subtype, 'rename')
    assert.equal(events[0].metadata.oldName, 'alpha')
    assert.equal(events[0].metadata.newName, 'bravo')
  })
})

test('/api/rename clear-name path also syncs FleetStore cache and live registry', async () => {
  await withRenameServer(async ({ base, store }) => {
    const events = []
    store.onEvent(event => events.push(event))
    store.upsertAgent({ id: 'fleet:a', friendly_name: 'alpha', dead: false })
    assert.equal(store.findAgent('alpha')?.id, 'fleet:a')
    assert.equal(store.getAgentNameMap()['fleet:a'], 'alpha')

    const res = await rename(base, { agent: 'alpha', name: '' })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json, { ok: true, agent: 'fleet:a', name: null })

    assert.equal(store.findAgent('alpha'), null)
    assert.deepEqual(store.resolveChatRecipients(parseFilter('alpha'), { filter: 'alpha' }), [])
    assert.equal(store.getAgent('fleet:a').friendly_name, null)
    assert.equal(store.getAgentNameMap()['fleet:a'], 'fleet:a')
    assert.equal(events.length, 1)
    assert.equal(events[0].metadata.oldName, 'alpha')
    assert.equal(events[0].metadata.newName, null)
  })
})
