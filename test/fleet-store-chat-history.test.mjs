#!/usr/bin/env node

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { FleetStore } from '../server/lib/fleet-store.mjs'

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-store-chat-history-'))
  const store = new FleetStore(path.join(dir, 'fleet.db'))
  return Promise.resolve()
    .then(() => fn(store))
    .finally(() => {
      store.close()
      fs.rmSync(dir, { recursive: true, force: true })
    })
}

describe('FleetStore chat history', () => {
  it('keeps normal agent-scoped history exact across lineage-related fleet ids', async () => withStore(async (store) => {
    store.upsertAgent({ id: 'fleet:chief-day', friendly_name: 'chief:day', labels: [] })
    store.upsertAgent({ id: 'fleet:chief-dusk', friendly_name: 'chief:dusk', labels: [] })

    const lineage = store.getOrCreateLineage('chief')
    store.assignPhase('fleet:chief-day', lineage.id, 'day')
    store.assignPhase('fleet:chief-dusk', lineage.id, 'dusk')

    await store.share({
      type: 'chat',
      from: 'fleet:chief-dusk',
      to: 'fleet:skip',
      text: 'dusk-only history',
      unread: false,
    })
    await store.share({
      type: 'chat',
      from: 'fleet:chief-day',
      to: 'fleet:skip',
      text: 'day exact history',
      unread: false,
    })

    const events = store.queryChatHistory({ agents: ['fleet:chief-day'], limit: 10 })

    assert.deepEqual(events.map(e => e.text), ['day exact history'])
  }))
})
