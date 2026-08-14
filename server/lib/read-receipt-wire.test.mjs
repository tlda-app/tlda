import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'

import { FleetStore } from './fleet-store.mjs'

async function unusedPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function waitForServer(child) {
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const deadline = Date.now() + 90_000
  while (!output.includes('Unified server running')) {
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}: ${output}`)
    if (Date.now() >= deadline) throw new Error(`server did not start: ${output}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function openSocket(port) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws/fleet`, { rejectUnauthorized: false })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return ws
}

function nextMessage(ws, predicate, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error(`timed out waiting for ${label}`))
    }, 10_000)
    function onMessage(raw) {
      const message = JSON.parse(String(raw))
      if (!predicate(message)) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(message)
    }
    ws.on('message', onMessage)
  })
}

function request(ws, id, body) {
  const response = nextMessage(ws, message => message.id === id, `response ${id}`)
  ws.send(JSON.stringify({ id, ...body }))
  return response.then(message => {
    if (message.error) throw new Error(message.error)
    return message.result
  })
}

test('recipient read crosses the production wire into sender receipt and history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-read-receipt-wire-'))
  const dbPath = join(dir, 'fleet.db')
  const seed = new FleetStore(dbPath, { taskDoc: false })
  try {
    await seed.upsertAgent({ id: 'fleet:sender', friendly_name: 'sender', dead: false })
    await seed.upsertAgent({ id: 'fleet:recipient', friendly_name: 'recipient', dead: false })
  } finally {
    seed.close()
  }

  const port = await unusedPort()
  const child = spawn(process.execPath, ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: join(import.meta.dirname, '..', '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      PROJECTS_DIR: join(dir, 'projects'),
      TLDA_FLEET_DB: dbPath,
      TLDA_DEV_SERVER: '1',
      TLDA_TASK_DOC_STARTUP_FLUSH_DELAY_MS: '-1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let sender
  let recipient
  let history
  let eventId
  try {
    await waitForServer(child)
    sender = await openSocket(port)
    recipient = await openSocket(port)
    await request(sender, 1, {
      type: 'subscribe-filter', subId: 'sender-live', filter: [[['from', 'fleet:sender']]],
      humanId: 'fleet:sender', window: 0,
    })

    const liveEvent = nextMessage(sender, message =>
      message.event === 'filter-event' &&
      message.data?.subId === 'sender-live' &&
      message.data?.event?.text === 'receipt proof',
    'live chat event')
    const sent = await request(sender, 2, {
      type: 'chat', from: 'fleet:sender', to: 'fleet:recipient', message: 'receipt proof',
    })
    eventId = sent.event_ids[0]
    const live = await liveEvent
    assert.equal(live.data.event.id, eventId)
    assert.equal(live.data.event.readBy ?? 0, 0)

    const receiptUpdate = nextMessage(sender, message =>
      message.event === 'filter-event' &&
      message.data?.subId === 'sender-live' &&
      message.data?.updateOnly === true &&
      message.data?.event?.id === eventId,
    'authoritative sender receipt update')
    const marked = await request(recipient, 3, {
      type: 'mark-event-read', event_id: eventId, agent: 'fleet:recipient',
    })
    assert.deepEqual(marked, { ok: true, changed: true })
    const receipt = await receiptUpdate
    assert.equal(receipt.data.event.readBy, 1)
    assert.equal(receipt.data.event.recipientCount, 1)
    assert.deepEqual(receipt.data.event.readers, ['fleet:recipient'])

    history = await openSocket(port)
    const historyPage = nextMessage(history, message =>
      message.event === 'filter-events' &&
      message.data?.subId === 'sender-history' &&
      message.data?.reason === 'history',
    'sender history page')
    await request(history, 4, {
      type: 'subscribe-filter', subId: 'sender-history', filter: [[['from', 'fleet:sender']]],
      humanId: 'fleet:sender', window: 20,
    })
    const page = await historyPage
    const readback = page.data.events.find(event => event.id === eventId)
    assert.ok(readback, JSON.stringify(page.data.events))
    assert.equal(readback.readBy, 1)
    assert.equal(readback.recipientCount, 1)
    assert.deepEqual(readback.readers, ['fleet:recipient'])
  } finally {
    sender?.close()
    recipient?.close()
    history?.close()
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
  }

  try {
    const persisted = new FleetStore(dbPath, { taskDoc: false })
    try {
      const row = persisted.db.prepare(
        'SELECT read FROM recipients WHERE event_id = ? AND agent_id = ?',
      ).get(eventId, 'fleet:recipient')
      assert.equal(row.read, 1)
    } finally {
      persisted.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
