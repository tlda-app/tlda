import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
import { SERVER_DAEMON_OUTBOX_ID_FIELD } from '../shared/daemon-delivery.mjs'
import { ServerDaemonOutbox } from '../server/lib/server-daemon-outbox.mjs'

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-server-daemon-outbox-'))
  return new Database(path.join(dir, 'outbox.sqlite'))
}

test('persists server to daemon messages in FIFO order', () => {
  let tick = 0
  const db = tempDb()
  const outbox = new ServerDaemonOutbox(db, { clock: () => `2026-07-10T00:00:0${tick++}.000Z` })
  outbox.enqueue('air:live', { type: 'agents-updated', agents: [] }, { id: 'first' })
  outbox.enqueue('air:live', { type: 'projects-updated', projects: [] }, { id: 'second' })

  const rows = outbox.pendingForDaemon('air:live')
  assert.deepEqual(rows.map(row => row.id), ['first', 'second'])
  assert.equal(rows[0].payload[SERVER_DAEMON_OUTBOX_ID_FIELD], 'first')
  assert.equal(outbox.count(), 2)
  db.close()
})

test('ack removes only the acknowledged server to daemon message', () => {
  const db = tempDb()
  const outbox = new ServerDaemonOutbox(db)
  outbox.enqueue('air:live', { type: 'agents-updated', agents: [] }, { id: 'first' })
  outbox.enqueue('air:live', { type: 'projects-updated', projects: [] }, { id: 'second' })

  outbox.ack('first')

  assert.deepEqual(outbox.pendingForDaemon('air:live').map(row => row.id), ['second'])
  assert.equal(outbox.countForDaemon('air:live'), 1)
  db.close()
})

test('dedupe key keeps only the newest state snapshot', () => {
  const db = tempDb()
  const outbox = new ServerDaemonOutbox(db)
  outbox.enqueue('air:live', { type: 'projects-updated', projects: [{ name: 'old' }] }, {
    id: 'old',
    dedupeKey: 'projects-updated',
  })
  outbox.enqueue('air:live', { type: 'projects-updated', projects: [{ name: 'new' }] }, {
    id: 'new',
    dedupeKey: 'projects-updated',
  })

  const rows = outbox.pendingForDaemon('air:live')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'new')
  assert.deepEqual(rows[0].payload.projects, [{ name: 'new' }])
  db.close()
})
