// An amend notifies, proven across the wire it crosses in production.
//
// The store-level tests next door prove that an amend now lands unread and that
// its delivery resolves to `notified`. Neither is delivery. This project has
// shipped three notification paths that were green on both ends with nothing
// between them, so the sender's function and the receiver's function passing is
// exactly the evidence that means nothing here.
//
// So this spawns the real unified server, opens a real fleet socket as the
// recipient's MCP channel, sends a real chat and then a real amend of it, and
// asserts the 📬 frame arrives on that channel carrying the amended text. That
// is the MCP/harness path, which is the only path that earns the word
// delivered.
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

async function openFleetWs(port) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws/fleet`, { rejectUnauthorized: false })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return ws
}

function request(ws, id, type, payload) {
  return new Promise((resolve, reject) => {
    const onMessage = raw => {
      const message = JSON.parse(String(raw))
      if (message.id !== id) return
      ws.off('message', onMessage)
      if (message.error) reject(new Error(message.error))
      else resolve(message.result)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, type, ...payload }))
  })
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

test('an amend reaches the recipient channel as a notification', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-amend-notify-wire-'))
  const dbPath = join(dir, 'fleet.db')
  const store = new FleetStore(dbPath, { taskDoc: false })
  const now = new Date().toISOString()
  await store.upsertAgent({ id: 'fleet:sender', friendly_name: 'sender', labels: [], registered_at: now, last_seen: now })
  await store.upsertAgent({ id: 'fleet:recipient', friendly_name: 'recipient', labels: [], registered_at: now, last_seen: now })
  await store.ensureSubscription({ owner: 'fleet:recipient', query: 'to:me', notificationPolicy: 'immediate' })
  store.close()

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
  let recipientWs
  let senderWs
  try {
    await waitForServer(child)

    recipientWs = await openFleetWs(port)
    await request(recipientWs, 'recipient-login', 'login', {
      operation_id: 'amend-notify-wire-login',
      agent_id: 'fleet:recipient',
      machine_id: 'mini',
      env_name: 'testing',
    })
    // Every 📬 that lands on this channel, in order, with its text — this is the
    // recipient surface and nothing stands in for it.
    const notifications = []
    recipientWs.on('message', raw => {
      const frame = JSON.parse(String(raw))
      if (frame.event !== 'channel-notification') return
      notifications.push(String(frame.data?.text || frame.data?.message || ''))
      const ackId = frame.data?.metadata?.wake_ack_id
      if (ackId) {
        recipientWs.send(JSON.stringify({ id: 100, type: 'channel-notification-ack', agent: 'fleet:recipient', ack_id: ackId }))
      }
    })

    senderWs = await openFleetWs(port)
    // The positive control. Without it, an empty `notifications` at the end
    // would say nothing about amends — only that this rig never delivers.
    const sent = await request(senderWs, 2, 'chat', {
      from: 'fleet:sender',
      to: 'recipient',
      message: 'the question, answered wrong the first time',
      _tempId: 'amend-notify-wire-original',
    })
    assert.equal(sent.ok, true)
    const originalId = sent.event_ids[0]

    const deadline = Date.now() + 5000
    while (notifications.length < 1 && Date.now() < deadline) await sleep(25)
    assert.equal(notifications.length, 1, 'control: an ordinary chat must notify this channel')

    // The amend. This is what an agent does when it answers Skip by correcting
    // the message it already sent him.
    const amended = await request(senderWs, 3, 'amend', {
      from: 'fleet:sender',
      event_id: originalId,
      message: 'THE ACTUAL ANSWER',
    })
    assert.equal(amended.ok, true)
    assert.equal(amended.event_id, originalId, 'an amend chains off the original')

    const amendDeadline = Date.now() + 5000
    while (notifications.length < 2 && Date.now() < amendDeadline) await sleep(25)
    assert.equal(notifications.length, 2, 'the amend must notify — this is the whole defect')
    assert.match(notifications[1], /THE ACTUAL ANSWER/, 'and the notification must carry the amended text, not the text it replaced')
  } finally {
    recipientWs?.close()
    senderWs?.close()
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    rmSync(dir, { recursive: true, force: true })
  }
})
