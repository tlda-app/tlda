#!/usr/bin/env node

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { FleetStore } from '../server/lib/fleet-store.mjs'

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-store-activity-search-'))
  const store = new FleetStore(path.join(dir, 'fleet.db'))
  return Promise.resolve()
    .then(() => fn(store))
    .finally(() => {
      store.close()
      fs.rmSync(dir, { recursive: true, force: true })
    })
}

describe('FleetStore activity search', () => {
  it('indexes activity metadata used by rendered tool cards', async () => withStore(async (store) => {
    await store.share({
      type: 'activity',
      from: 'fleet:agent',
      to: 'fleet:agent',
      text: 'Edit',
      metadata: {
        tool: 'Edit',
        arg: 'src/example.js',
        input: {
          command: 'node src/example.js',
          description: 'update example',
        },
        prettyResult: 'rendered result',
      },
      unread: false,
    })

    assert.equal(store.search('example', { type: 'activity' }).length, 1)
    assert.equal(store.search('update', { type: 'activity' }).length, 1)
    assert.equal(store.search('rendered', { type: 'activity' }).length, 1)
  }))

  it('keeps activity metadata terms consistent across update and delete', async () => withStore(async (store) => {
    const event = await store.share({
      type: 'activity',
      from: 'fleet:agent',
      to: 'fleet:agent',
      text: 'Edit',
      metadata: { tool: 'Edit', arg: 'oldtoken.js' },
      unread: false,
    })

    assert.equal(store.search('oldtoken', { type: 'activity' }).length, 1)

    store.db.prepare('UPDATE events SET metadata = ? WHERE id = ?')
      .run(JSON.stringify({ tool: 'Edit', arg: 'newtoken.js' }), event.id)

    assert.equal(store.search('oldtoken', { type: 'activity' }).length, 0)
    assert.equal(store.search('newtoken', { type: 'activity' }).length, 1)

    store.db.prepare('DELETE FROM events WHERE id = ?').run(event.id)

    assert.equal(store.search('newtoken', { type: 'activity' }).length, 0)
  }))
})
