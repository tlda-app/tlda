import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { FleetStore } from '../server/lib/fleet-store.mjs'

function tempStore() {
  const dbPath = path.join(os.tmpdir(), `fleet-wiretap-types-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    fs.rmSync(file, { force: true })
  }
  return { store: new FleetStore(dbPath), dbPath }
}

function cleanup(store, dbPath) {
  store.close()
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    fs.rmSync(file, { force: true })
  }
}

test('wiretap subscriptions do not CC high-volume activity telemetry', async () => {
  const { store, dbPath } = tempStore()
  try {
    store.upsertAgent({ id: 'fleet:sender', friendly_name: 'sender' })
    store.upsertAgent({ id: 'fleet:recipient', friendly_name: 'recipient' })
    store.upsertAgent({ id: 'fleet:watcher', friendly_name: 'watcher' })
    store.addWiretap('fleet:watcher', 'to:recipient', null)

    const chat = await store.share({
      type: 'chat',
      from: 'fleet:sender',
      to: 'fleet:recipient',
      text: 'ordinary message',
    })
    assert.deepEqual(chat.metadata.wiretap_cc, ['fleet:watcher'])
    const watcherInbox = store.getUnread('fleet:watcher')
    assert.deepEqual(watcherInbox.map(event => event.id), [chat.id])
    assert.equal(watcherInbox[0].text, 'ordinary message')

    const activity = await store.share({
      type: 'activity',
      from: 'fleet:recipient',
      to: 'fleet:recipient',
      text: 'tool_call',
      unread: false,
    })
    assert.equal(activity.metadata?.wiretap_cc, undefined)

    const attempt = await store.share({
      type: 'notification_attempt',
      from: 'fleet:tlda',
      to: 'fleet:recipient',
      text: 'notification delivered',
      unread: false,
    })
    assert.equal(attempt.metadata?.wiretap_cc, undefined)
  } finally {
    cleanup(store, dbPath)
  }
})
