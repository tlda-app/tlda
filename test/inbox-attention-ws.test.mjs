import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import WebSocket from 'ws'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function connectWs(url, wsOpts) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, wsOpts)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function fleetRpc(ws) {
  let seq = 0
  const pending = new Map()
  ws.on('message', raw => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    if (!msg.id || !pending.has(msg.id)) return
    pending.get(msg.id)(msg.result ?? msg)
    pending.delete(msg.id)
  })
  return (type, params = {}) => new Promise(resolve => {
    const id = `t${++seq}`
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, type, ...params }))
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        resolve(null)
      }
    }, 5000)
  })
}

async function waitFor(predicate, { timeoutMs = 30000, intervalMs = 250 } = {}) {
  const start = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await sleep(intervalMs)
  }
}

function cleanup(label, fn) {
  try {
    fn()
  } catch (e) {
    // Best-effort cleanup: primary assertion failures should remain visible.
    console.warn(`[inbox-attention-ws] cleanup failed for ${label}: ${e.message}`)
  }
}

test('chat attention policy is reflected in receipts and unread inbox metadata', async () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..')
  const port = 5300 + (process.pid % 1000)
  const db = path.join(os.tmpdir(), `inbox-attention-ws-${process.pid}.db`)
  const projects = path.join(os.tmpdir(), `inbox-attention-projects-${process.pid}`)
  const useTls = fs.existsSync(path.join(os.homedir(), '.config/tlda/localhost+2.pem'))
  const proto = useTls ? 'https' : 'http'
  const wsProto = useTls ? 'wss' : 'ws'
  const wsOpts = useTls ? { rejectUnauthorized: false } : {}
  const server = spawn('node', ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      TLDA_FLEET_DB: db,
      PROJECTS_DIR: projects,
      TLDA_DEV_SERVER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let serverLog = ''
  server.stdout.on('data', d => { serverLog += d })
  server.stderr.on('data', d => { serverLog += d })
  let fleet
  try {
    await waitFor(async () => {
      try {
        const res = await fetch(`${proto}://127.0.0.1:${port}/api/health`)
        return res.ok
      } catch {
        return false
      }
    })

    fleet = await connectWs(`${wsProto}://127.0.0.1:${port}/ws/fleet`, wsOpts)
    const sendFleet = fleetRpc(fleet)
    assert.equal((await sendFleet('register', { agent_id: 'fleet:sender', name: 'sender' }))?.ok, true)
    assert.equal((await sendFleet('register', { agent_id: 'fleet:recipient', name: 'recipient' }))?.ok, true)
    assert.equal((await sendFleet('register', { agent_id: 'fleet:manager', name: 'manager' }))?.ok, true)
    assert.equal((await sendFleet('register', { agent_id: 'fleet:outsider', name: 'outsider' }))?.ok, true)

    assert.equal((await sendFleet('delivery-channel', { caller: 'fleet:recipient', channel: 'channel' }))?.ok, true)
    assert.equal((await sendFleet('delegate', {
      from: 'fleet:manager',
      agent: 'fleet:recipient',
      description: 'Manage recipient delivery',
    }))?.ok, true)
    assert.equal((await sendFleet('delivery-channel', { caller: 'fleet:manager', agent: 'recipient', channel: 'channel' }))?.ok, true)
    await sendFleet('my-task', { agent: 'fleet:recipient' })
    const rejectedDelivery = await sendFleet('delivery-channel', { caller: 'fleet:outsider', agent: 'recipient', channel: 'tmux' })
    assert.match(rejectedDelivery?.error || '', /not that agent's manager/)
    assert.match(rejectedDelivery?.error || '', /Delegate them a task first/)
    const agentsAfterReject = await sendFleet('store-agents')
    assert.equal(agentsAfterReject.find(a => a.id === 'fleet:recipient')?.metadata?.deliveryChannel, 'channel')
    assert.equal((await sendFleet('inbox-status', { agent: 'fleet:recipient', status: 'busy', tag: 'spawn broken' }))?.ok, true)
    const busyNormal = await sendFleet('chat', {
      from: 'fleet:sender',
      to: 'recipient',
      message: 'normal update for batching',
      _tempId: 'attention-retry-1',
    })
    assert.equal(busyNormal?.receipts?.[0]?.delivery, 'batched')
    assert.equal(busyNormal.receipts[0].deliveryChannel, 'channel')
    assert.equal(busyNormal.receipts[0].priority, 'normal')
    assert.equal(busyNormal.receipts[0].status, 'busy')
    assert.equal(busyNormal.receipts[0].tag, 'spawn broken')
    assert.ok(busyNormal.receipts[0].notifyBy)
    const busyNormalRetry = await sendFleet('chat', {
      from: 'fleet:sender',
      to: 'recipient',
      message: 'normal update for batching',
      _tempId: 'attention-retry-1',
    })
    assert.deepEqual(busyNormalRetry.event_ids, busyNormal.event_ids)
    assert.deepEqual(busyNormalRetry.recipients, busyNormal.recipients)
    assert.deepEqual(busyNormalRetry.receipts, busyNormal.receipts)

    const busyImportant = await sendFleet('chat', {
      from: 'fleet:sender',
      to: 'recipient',
      message: 'this is important: please look before release',
    })
    assert.equal(busyImportant?.receipts?.[0]?.delivery, 'notified')
    assert.equal(busyImportant.receipts[0].priority, 'important')

    assert.equal((await sendFleet('inbox-status', { agent: 'fleet:recipient', status: 'dnd' }))?.ok, true)
    const dndImportant = await sendFleet('chat', {
      from: 'fleet:sender',
      to: 'recipient',
      message: 'this is important: parked until you are back',
    })
    assert.equal(dndImportant?.receipts?.[0]?.delivery, 'queued')
    assert.equal(dndImportant.receipts[0].priority, 'important')

    const dndUrgent = await sendFleet('chat', {
      from: 'fleet:sender',
      to: 'recipient',
      message: 'this is urgent: production gate',
    })
    assert.equal(dndUrgent?.receipts?.[0]?.delivery, 'notified')
    assert.equal(dndUrgent.receipts[0].priority, 'urgent')

    const inbox = await sendFleet('my-task', { agent: 'fleet:recipient', peek: true })
    assert.equal(inbox?.messages?.length, 4)
    const byText = new Map(inbox.messages.map(m => [m.text, m]))
    const batched = byText.get('normal update for batching')
    assert.equal(batched.metadata.priority, 'normal')
    assert.equal(batched.metadata.inbox_delivery, 'batched')
    assert.equal(batched.metadata.inbox_status, 'busy')
    assert.equal(batched.metadata.inbox_status_tag, 'spawn broken')
    assert.equal(batched.metadata.delivery_channel, 'channel')
    assert.ok(batched.metadata.notify_by)
    assert.equal(byText.get('this is important: please look before release').metadata.inbox_delivery, 'notified')
    assert.equal(byText.get('this is important: parked until you are back').metadata.inbox_delivery, 'queued')
    assert.equal(byText.get('this is urgent: production gate').metadata.inbox_delivery, 'notified')
  } catch (e) {
    e.message = `${e.message}\nserver log:\n${serverLog.slice(-2000)}`
    throw e
  } finally {
    cleanup('fleet ws', () => fleet?.close())
    cleanup('server process', () => server.kill('SIGKILL'))
    cleanup('projects dir', () => fs.rmSync(projects, { recursive: true, force: true }))
    cleanup('db', () => fs.rmSync(db, { force: true }))
    cleanup('db wal', () => fs.rmSync(`${db}-wal`, { force: true }))
    cleanup('db shm', () => fs.rmSync(`${db}-shm`, { force: true }))
  }
})
