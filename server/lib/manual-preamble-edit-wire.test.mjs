import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'

import { activityPreambleDoc } from '../../src/fleet/activity-preamble.mjs'
import { buildDaemonActivityRecord, configuredAgentPreambleRef } from './daemon-activity-ingest.mjs'
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

function subscribe(ws, subId, agentId) {
  ws.send(JSON.stringify({
    type: 'subscribe-filter', subId, filter: [[['from', agentId]]], window: 20,
  }))
}

function waitForSubscriptionEvent(ws, subId, predicate, timeoutMs = 20_000) {
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

test('manual preamble crosses the production daemon activity websocket and history reconnect', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-manual-preamble-socket-'))
  const dbPath = join(root, 'fleet.sqlite')
  const agentId = 'fleet:manual-preamble-socket'
  const store = new FleetStore(dbPath, { taskDoc: false })
  await store.upsertAgent({
    id: agentId, friendly_name: 'manual-preamble-socket', labels: [],
    registered_at: '2026-08-15T20:36:32.000Z', last_seen: '2026-08-15T20:36:32.000Z',
    dead: false, human: false,
    metadata: { chatPreamble: { doc: 'manual-macros', version: 'macro-version' } },
  })
  store.close()

  const port = await unusedPort()
  const child = spawn(process.execPath, ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: join(import.meta.dirname, '..', '..'),
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: String(port),
      PROJECTS_DIR: join(root, 'projects'), TLDA_FLEET_DB: dbPath,
      TLDA_DEV_SERVER: '1', TLDA_TASK_DOC_STARTUP_FLUSH_DELAY_MS: '-1',
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
    subscribe(liveClient, 'manual-live', agentId)
    daemon = await openSocket(`${base}/ws/fleet-daemon`)
    daemon.send(JSON.stringify({
      type: 'daemon-hello', machine_id: 'wire-machine', env_name: 'test',
      daemon_key: 'wire-machine:test', boot_id: 'manual-preamble-wire-boot',
      user: 'test', hostname: 'wire-machine', version: 'test',
    }))

    const operation = { operation_id: 'manual-preamble-socket-O1', kind: 'Edit', files: [{ path: 'main.tex' }] }
    const livePromise = waitForSubscriptionEvent(
      liveClient, 'manual-live', event => event.type === 'activity' && event.text === 'Edit',
    )
    daemon.send(JSON.stringify({
      type: 'activity-event', agent_id: agentId, tool: 'Edit', arg: 'main.tex',
      project: 'source-paper', sourceFile: 'main.tex', input: { edit_operation: operation },
      ts: '2026-08-15T20:36:33.000Z', status: 'started', correlationId: 'manual-preamble-socket-call',
    }))
    const liveEvent = await livePromise
    const liveMetadata = typeof liveEvent.metadata === 'string' ? JSON.parse(liveEvent.metadata) : liveEvent.metadata
    assert.deepEqual(liveMetadata.preambleRef, { doc: 'manual-macros', version: 'macro-version' })

    liveClient.close()
    liveClient = null
    historyClient = await openSocket(`${base}/ws/fleet`)
    const historyPromise = waitForSubscriptionEvent(
      historyClient, 'manual-history', event => event.type === 'activity' && event.text === 'Edit',
    )
    subscribe(historyClient, 'manual-history', agentId)
    const persistedEvent = await historyPromise
    const persistedMetadata = typeof persistedEvent.metadata === 'string'
      ? JSON.parse(persistedEvent.metadata)
      : persistedEvent.metadata
    assert.deepEqual(persistedMetadata.preambleRef, { doc: 'manual-macros', version: 'macro-version' })
  } finally {
    daemon?.close()
    liveClient?.close()
    historyClient?.close()
    child.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
})

test('source project remains the automatic preamble when no manual selection was captured', () => {
  assert.equal(activityPreambleDoc({
    metadata: { project: 'source-paper' },
    _toolInput: { canonical_source: { project: 'source-paper' } },
  }), 'source-paper')
})
