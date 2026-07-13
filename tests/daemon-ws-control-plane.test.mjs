import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'

import {
  DAEMON_OUTBOX_ACK_TYPE,
  DAEMON_OUTBOX_ERROR_TYPE,
  DAEMON_OUTBOX_ID_FIELD,
  SERVER_DAEMON_OUTBOX_ACK_TYPE,
} from '../shared/daemon-delivery.mjs'
import { ServerDaemonOutbox } from '../server/lib/server-daemon-outbox.mjs'
import { createDaemonWsControlPlane } from '../server/lib/daemon-ws-control-plane.mjs'

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-daemon-ws-control-plane-'))
  return new Database(path.join(dir, 'control.sqlite'))
}

function processedStatements(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daemon_outbox_processed (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      processed_at TEXT NOT NULL
    )
  `)
  return {
    get: db.prepare('SELECT 1 FROM daemon_outbox_processed WHERE id = ? LIMIT 1'),
    insert: db.prepare('INSERT OR IGNORE INTO daemon_outbox_processed (id, type, processed_at) VALUES (?, ?, ?)'),
  }
}

function makeControl({
  db = tempDb(),
  daemonConnections = new Map(),
  serverDaemonOutbox = new ServerDaemonOutbox(db),
  serverDaemonOutboxInflight = new Map(),
  socketCanAcceptMore = () => true,
  setTimeoutFn = setTimeout,
  log = { warn() {} },
} = {}) {
  const stmts = processedStatements(db)
  return {
    db,
    daemonConnections,
    serverDaemonOutbox,
    serverDaemonOutboxInflight,
    control: createDaemonWsControlPlane({
      daemonConnections,
      serverDaemonOutbox,
      serverDaemonOutboxInflight,
      daemonOutboxProcessedGetStmt: stmts.get,
      daemonOutboxProcessedInsertStmt: stmts.insert,
      socketCanAcceptMore,
      setTimeoutFn,
      clock: () => '2026-07-12T00:00:00.000Z',
      log,
    }),
  }
}

function openWs() {
  const sent = []
  return {
    readyState: 1,
    sent,
    send(raw) { sent.push(JSON.parse(raw)) },
  }
}

test('daemon outbox duplicate is acked without re-running handler', async () => {
  const { db, control } = makeControl()
  const ws = openWs()
  const msg = { type: 'activity-event', [DAEMON_OUTBOX_ID_FIELD]: 'daemon-row-1' }
  control.markDaemonOutboxMessageProcessed(msg)

  let handled = 0
  const result = await control.handleDaemonOutboxEnvelope(ws, msg, async () => { handled += 1 })

  assert.deepEqual(result, { handled: true, kind: 'duplicate-daemon-outbox' })
  assert.equal(handled, 0)
  assert.deepEqual(ws.sent, [{ type: DAEMON_OUTBOX_ACK_TYPE, outbox_id: 'daemon-row-1' }])
  db.close()
})

test('daemon outbox marks processed only after successful handler and then acks', async () => {
  const { db, control } = makeControl()
  const ws = openWs()
  const msg = { type: 'terminal-chat', [DAEMON_OUTBOX_ID_FIELD]: 'daemon-row-2' }

  assert.equal(control.isProcessedDaemonOutboxMessage(msg), false)
  const result = await control.handleDaemonOutboxEnvelope(ws, msg, async () => {})

  assert.deepEqual(result, { handled: true, kind: 'processed' })
  assert.equal(control.isProcessedDaemonOutboxMessage(msg), true)
  assert.deepEqual(ws.sent, [{ type: DAEMON_OUTBOX_ACK_TYPE, outbox_id: 'daemon-row-2' }])
  db.close()
})

test('daemon outbox handler error sends error reply without marking processed', async () => {
  const { db, control } = makeControl()
  const ws = openWs()
  const msg = { type: 'source-change', [DAEMON_OUTBOX_ID_FIELD]: 'daemon-row-3' }
  const err = Object.assign(new Error('Project not found'), { permanent: true })
  let observed = null

  const result = await control.handleDaemonOutboxEnvelope(ws, msg, async () => { throw err }, {
    onHandlerError: e => { observed = e },
  })

  assert.equal(result.handled, false)
  assert.equal(result.kind, 'error')
  assert.equal(result.error, err)
  assert.equal(observed, err)
  assert.equal(control.isProcessedDaemonOutboxMessage(msg), false)
  assert.deepEqual(ws.sent, [{
    type: DAEMON_OUTBOX_ERROR_TYPE,
    outbox_id: 'daemon-row-3',
    error: 'Project not found',
    permanent: true,
  }])
  db.close()
})

test('server daemon outbox ack removes row and inflight marker', async () => {
  const { db, control, serverDaemonOutbox, serverDaemonOutboxInflight } = makeControl()
  serverDaemonOutbox.enqueue('air:default', { type: 'projects-updated', projects: [] }, { id: 'server-row-1' })
  serverDaemonOutboxInflight.set('server-row-1', 'air:default')

  const result = await control.handleDaemonOutboxEnvelope(
    openWs(),
    { type: SERVER_DAEMON_OUTBOX_ACK_TYPE, outbox_id: 'server-row-1' },
    async () => { throw new Error('handler should not run') },
  )

  assert.deepEqual(result, { handled: true, kind: 'server-daemon-outbox-ack' })
  assert.equal(serverDaemonOutbox.countForDaemon('air:default'), 0)
  assert.equal(serverDaemonOutboxInflight.has('server-row-1'), false)
  db.close()
})

test('server daemon outbox flush sends pending rows once and cleanup clears only daemon inflight rows', () => {
  const daemonConnections = new Map()
  const serverDaemonOutboxInflight = new Map()
  const { db, control, serverDaemonOutbox } = makeControl({ daemonConnections, serverDaemonOutboxInflight })
  const ws = openWs()
  daemonConnections.set('air:default', ws)
  serverDaemonOutbox.enqueue('air:default', { type: 'agents-updated', agents: [] }, { id: 'server-row-2' })
  serverDaemonOutbox.enqueue('mini:default', { type: 'projects-updated', projects: [] }, { id: 'server-row-3' })
  serverDaemonOutboxInflight.set('other-row', 'mini:default')

  control.flushServerDaemonOutbox('air:default')
  control.flushServerDaemonOutbox('air:default')

  assert.equal(ws.sent.length, 1)
  assert.equal(ws.sent[0].type, 'agents-updated')
  assert.equal(ws.sent[0].__server_daemon_outbox_id, 'server-row-2')
  assert.equal(serverDaemonOutboxInflight.get('server-row-2'), 'air:default')

  control.clearServerDaemonOutboxInflightForDaemon('air:default')
  assert.equal(serverDaemonOutboxInflight.has('server-row-2'), false)
  assert.equal(serverDaemonOutboxInflight.get('other-row'), 'mini:default')
  assert.equal(serverDaemonOutbox.countForDaemon('air:default'), 1, 'pending row is not dropped by inflight cleanup')
  db.close()
})

test('server daemon outbox congested socket schedules retry without marking inflight', () => {
  const daemonConnections = new Map()
  const timers = []
  const { db, control, serverDaemonOutbox, serverDaemonOutboxInflight } = makeControl({
    daemonConnections,
    socketCanAcceptMore: () => false,
    setTimeoutFn: (fn, ms) => {
      timers.push({ fn, ms })
      return { unref() {} }
    },
  })
  daemonConnections.set('air:default', openWs())
  serverDaemonOutbox.enqueue('air:default', { type: 'projects-updated', projects: [] }, { id: 'server-row-4' })

  control.flushServerDaemonOutbox('air:default')

  assert.equal(timers.length, 1)
  assert.equal(timers[0].ms, 25)
  assert.equal(serverDaemonOutboxInflight.has('server-row-4'), false)
  assert.equal(serverDaemonOutbox.countForDaemon('air:default'), 1)
  db.close()
})
