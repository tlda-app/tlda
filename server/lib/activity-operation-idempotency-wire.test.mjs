import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'

import { buildDaemonActivityRecord } from './daemon-activity-ingest.mjs'
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

async function openSocket(url) {
  const ws = new WebSocket(url, { rejectUnauthorized: false })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return ws
}

function subscribe(ws, subId, agentId, window = 20) {
  ws.send(JSON.stringify({
    type: 'subscribe-filter', subId, filter: [[['from', agentId]]], window,
  }))
}

function eventMetadata(event) {
  return typeof event?.metadata === 'string' ? JSON.parse(event.metadata) : (event?.metadata || {})
}

function waitForLiveEvent(ws, subId, predicate, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error(`no matching ${subId} event within ${timeoutMs}ms`))
    }, timeoutMs)
    const onMessage = raw => {
      let message
      try { message = JSON.parse(raw.toString()) } catch { return }
      if (message.data?.subId !== subId) return
      const events = message.event === 'filter-event'
        ? [message.data.event]
        : message.event === 'filter-events' ? (message.data.events || []) : []
      const event = events.find(predicate)
      if (!event) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(event)
    }
    ws.on('message', onMessage)
  })
}

function waitForHistoryBurst(ws, subId, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error(`no ${subId} history burst within ${timeoutMs}ms`))
    }, timeoutMs)
    const onMessage = raw => {
      let message
      try { message = JSON.parse(raw.toString()) } catch { return }
      if (message.data?.subId !== subId) return
      if (message.event !== 'filter-events') return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(message.data.events || [])
    }
    ws.on('message', onMessage)
  })
}

test('a re-sent activity operation stores one row and keeps its identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-activity-opidempotency-'))
  const dbPath = join(root, 'fleet.sqlite')
  const agentId = 'fleet:activity-opidempotency'
  const store = new FleetStore(dbPath, { taskDoc: false })
  await store.upsertAgent({
    id: agentId, friendly_name: 'activity-opidempotency', labels: [],
    registered_at: '2026-09-23T19:00:00.000Z', last_seen: '2026-09-23T19:00:00.000Z',
    dead: false, human: false,
  })
  store.close()

  // Test-only boot shim: some shells deny os.setPriority (EACCES), which
  // fleet-search-client treats as fatal at server boot. Swallow EACCES so the
  // server under test can start; rethrow anything else. Inert in shells where
  // setPriority works. Written to the test temp dir; imported by no test file.
  const shimPath = join(root, 'setpriority-eacces-shim.cjs')
  writeFileSync(shimPath, `
const os = require('node:os')
const originalSetPriority = os.setPriority
os.setPriority = (...args) => {
  try {
    return originalSetPriority.apply(os, args)
  } catch (error) {
    if (error?.info?.code === 'EACCES' || /EACCES/.test(error?.message || '')) return
    throw error
  }
}
`)

  const port = await unusedPort()
  const child = spawn(process.execPath, ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: join(import.meta.dirname, '..', '..'),
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port),
      PROJECTS_DIR: join(root, 'projects'), TLDA_FLEET_DB: dbPath,
      TLDA_DEV_SERVER: '1', TLDA_TASK_DOC_STARTUP_FLUSH_DELAY_MS: '-1',
      NODE_OPTIONS: [`--require=${shimPath}`, process.env.NODE_OPTIONS].filter(Boolean).join(' '),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let daemon
  let liveClient
  let historyClient
  try {
    await waitForServer(child)
    const base = `wss://127.0.0.1:${port}`
    liveClient = await openSocket(`${base}/ws/fleet`)
    subscribe(liveClient, 'opid-live', agentId)
    daemon = await openSocket(`${base}/ws/fleet-daemon`)
    daemon.send(JSON.stringify({
      type: 'daemon-hello', machine_id: 'wire-machine', env_name: 'test',
      daemon_key: 'wire-machine:test', boot_id: 'activity-opidempotency-boot',
      user: 'test', hostname: 'wire-machine', version: 'test',
    }))

    const liveSend = {
      type: 'activity-event', agent_id: agentId, tool: 'Bash', arg: 'echo opid-wire-A',
      ts: '2026-09-23T19:00:01.000Z', status: 'completed', operation_id: 'wire-op-A',
    }
    // The backfill copy of the same record: same operation identity, stamped
    // historical exactly as bufferHistoricalActivity sends it.
    const backfillCopy = { ...liveSend, historical: true }
    const barrierSend = {
      ...liveSend, arg: 'echo opid-wire-B', operation_id: 'wire-op-B',
      ts: '2026-09-23T19:00:02.000Z',
    }
    daemon.send(JSON.stringify(liveSend))
    daemon.send(JSON.stringify(backfillCopy))
    daemon.send(JSON.stringify(barrierSend))

    // The barrier proves the server processed both A sends: the socket
    // preserves send order, so B's broadcast cannot precede A's duplicate.
    const barrierEvent = await waitForLiveEvent(
      liveClient, 'opid-live',
      event => event.type === 'activity' && eventMetadata(event).client_operation_id === 'wire-op-B',
    )
    assert.equal(eventMetadata(barrierEvent).client_operation_id, 'wire-op-B')

    historyClient = await openSocket(`${base}/ws/fleet`)
    const burstPromise = waitForHistoryBurst(historyClient, 'opid-history')
    subscribe(historyClient, 'opid-history', agentId)
    const history = await burstPromise
    const rowsA = history.filter(event =>
      event.type === 'activity' && eventMetadata(event).client_operation_id === 'wire-op-A')
    const rowsB = history.filter(event =>
      event.type === 'activity' && eventMetadata(event).client_operation_id === 'wire-op-B')
    assert.equal(rowsA.length, 1)
    assert.equal(rowsA[0].text, 'Bash')
    assert.equal(rowsB.length, 1)
  } finally {
    daemon?.close()
    liveClient?.close()
    historyClient?.close()
    child.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
})

test('daemon activity ingest stamps the wire operation id onto the record', () => {
  const stamped = buildDaemonActivityRecord({ agent_id: 'fleet:x', tool: 'Bash', operation_id: 'op-1' })
  assert.equal(stamped.metadata.client_operation_id, 'op-1')
  const unstamped = buildDaemonActivityRecord({ agent_id: 'fleet:x', tool: 'Bash' })
  assert.ok(!('client_operation_id' in unstamped.metadata))
})

test('fleet store finds an activity row by its operation identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-activity-opid-lookup-'))
  const store = new FleetStore(join(root, 'fleet.sqlite'), { taskDoc: false })
  try {
    assert.equal(store.activityOperationDuplicateExists('op-9'), false)
    assert.equal(store.activityOperationDuplicateExists(null), false)
    await store.share({
      type: 'activity', from: 'fleet:x', to: 'fleet:x', text: 'Bash',
      metadata: { client_operation_id: 'op-9' }, unread: false,
    })
    assert.equal(store.activityOperationDuplicateExists('op-9'), true)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
})
