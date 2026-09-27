import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'

import { FleetStore } from '../server/lib/fleet-store.mjs'
import { activityEventMessage } from '../agent-runtime/activity-send.mjs'

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

function serveViewLine(itemId, callId) {
  return {
    jsonrpc: '2.0',
    method: 'item/completed',
    params: {
      sessionId: 'serve-wire',
      item: {
        itemId, kind: 'toolCall', status: 'completed',
        recordedAt: '2026-09-23T03:12:37Z',
        tool: 'write_file', callId,
        args: '{"content":"done","path":"/tmp/x/serve-wire.txt"}',
        visibleOutput: 'wrote 4 bytes to /tmp/x/serve-wire.txt',
      },
    },
  }
}

// A live serve-mode muse agent emits one tool call through the serve feed
// twice (restart replay); the server must store one activity row. The
// counterfactual (same bytes, no operation identity) stores two — proving
// the instrument measures the guard rather than the send path.
test('a replayed serve-mode tool call stores one activity row', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-serve-opidempotency-'))
  const dbPath = join(root, 'fleet.sqlite')
  const agentId = 'fleet:serve-opidempotency'
  const store = new FleetStore(dbPath, { taskDoc: false })
  await store.upsertAgent({
    id: agentId, friendly_name: 'serve-opidempotency', labels: [],
    registered_at: '2026-09-23T19:00:00.000Z', last_seen: '2026-09-23T19:00:00.000Z',
    dead: false, human: false,
  })
  store.close()

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
    cwd: join(import.meta.dirname, '..'),
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
    // Same rule as the server (776b4fe93): readable certs → TLS, else the
    // plain-HTTP fallback. Under a secrets fence the pair exists but reads
    // EPERM, so the booted server speaks ws and a wss dial dies EPROTO.
    let serverTls = false
    try {
      readFileSync(process.env.TLDA_TLS_CERT || join(homedir(), '.config/tlda/localhost+2.pem'))
      readFileSync(process.env.TLDA_TLS_KEY || join(homedir(), '.config/tlda/localhost+2-key.pem'))
      serverTls = true
    } catch { /* plain-HTTP fallback */ }
    const base = `${serverTls ? 'wss' : 'ws'}://127.0.0.1:${port}`
    liveClient = await openSocket(`${base}/ws/fleet`)
    subscribe(liveClient, 'serve-live', agentId)
    daemon = await openSocket(`${base}/ws/fleet-daemon`)
    daemon.send(JSON.stringify({
      type: 'daemon-hello', machine_id: 'serve-wire-machine', env_name: 'test',
      daemon_key: 'serve-wire-machine:test', boot_id: 'serve-opidempotency-boot',
      user: 'test', hostname: 'serve-wire-machine', version: 'test',
    }))

    // Drive the REAL serve ingest over a live view.jsonl: one tool call,
    // then a restart replay (fresh ingest re-reads the same bytes).
    const stateDir = join(root, 'serve-state')
    mkdirSync(stateDir, { recursive: true })
    const viewPath = join(stateDir, 'view.jsonl')
    const line = `${JSON.stringify(serveViewLine('wire-i1', 'wire-call-1'))}\n`
    writeFileSync(viewPath, line)
    const first = []
    const second = []
    // The temp state dir stands in for serveStateDir(tmuxSession): replicate
    // ingestAgent's mapping over the live file (same imports, same stamper),
    // then deliver through the real wire message shape.
    const { mspViewNotificationToParserRecords } = await import('../agent-runtime/muse-serve-events.mjs')
    const { createMuseRecordParser } = await import('../agent-runtime/muse-activity.mjs')
    const { extractActivityEvents } = await import('../daemon/activity-events.mjs')
    const { museServeOperationStamper } = await import('../agent-runtime/muse-serve-ingest.mjs')
    async function emitOnce(into) {
      const parse = createMuseRecordParser()
      const { readFileSync } = await import('node:fs')
      for (const raw of readFileSync(viewPath, 'utf8').split('\n')) {
        if (!raw.trim()) continue
        for (const record of mspViewNotificationToParserRecords(JSON.parse(raw))) {
          const ev = parse(record)
          if (!ev) continue
          const activity = extractActivityEvents(
            [ev],
            museServeOperationStamper({ agentId, recordKey: record?.id }),
          )
          for (const evt of activity) into.push(activityEventMessage(agentId, evt))
        }
      }
    }
    await emitOnce(first)
    await emitOnce(second) // restart replay: same bytes, same identities
    assert.equal(first.length, 1)
    assert.equal(second.length, 1)
    assert.equal(second[0].operation_id, first[0].operation_id)
    assert.match(first[0].operation_id || '', /^muse-serve:/)

    const replay = { ...first[0], type: 'activity-event' }
    const barrier = {
      type: 'activity-event', agent_id: agentId, tool: 'Bash', arg: 'echo serve-wire-B',
      ts: '2026-09-23T19:00:02.000Z', status: 'completed', operation_id: 'serve-wire-op-B',
    }
    daemon.send(JSON.stringify({ ...first[0], type: 'activity-event' }))
    daemon.send(JSON.stringify(replay))
    daemon.send(JSON.stringify(barrier))

    const barrierEvent = await waitForLiveEvent(
      liveClient, 'serve-live',
      event => event.type === 'activity' && eventMetadata(event).client_operation_id === 'serve-wire-op-B',
    )
    assert.equal(eventMetadata(barrierEvent).client_operation_id, 'serve-wire-op-B')

    historyClient = await openSocket(`${base}/ws/fleet`)
    const burstPromise = waitForHistoryBurst(historyClient, 'serve-history')
    subscribe(historyClient, 'serve-history', agentId)
    const history = await burstPromise
    const rowsServe = history.filter(event =>
      event.type === 'activity' && eventMetadata(event).client_operation_id === first[0].operation_id)
    const rowsB = history.filter(event =>
      event.type === 'activity' && eventMetadata(event).client_operation_id === 'serve-wire-op-B')
    assert.equal(rowsServe.length, 1)
    assert.equal(rowsServe[0].text, 'Write')
    assert.equal(rowsB.length, 1)

    // Counterfactual: the same payload with no operation identity stores
    // twice — the guard has nothing to dedupe on, so the instrument measures.
    const noId = {
      type: 'activity-event', agent_id: agentId, tool: 'Bash', arg: 'echo serve-wire-noid',
      ts: '2026-09-23T19:00:03.000Z', status: 'completed',
    }
    const barrier2 = { ...barrier, arg: 'echo serve-wire-C', operation_id: 'serve-wire-op-C' }
    daemon.send(JSON.stringify(noId))
    daemon.send(JSON.stringify({ ...noId }))
    daemon.send(JSON.stringify(barrier2))
    await waitForLiveEvent(
      liveClient, 'serve-live',
      event => event.type === 'activity' && eventMetadata(event).client_operation_id === 'serve-wire-op-C',
    )
    const historyClient2 = await openSocket(`${base}/ws/fleet`)
    try {
      const burst2 = waitForHistoryBurst(historyClient2, 'serve-history-2')
      subscribe(historyClient2, 'serve-history-2', agentId)
      const history2 = await burst2
      const rowsNoId = history2.filter(event =>
        event.type === 'activity' && (eventMetadata(event).arg || event.text) &&
        JSON.stringify(eventMetadata(event)).includes('echo serve-wire-noid'))
      assert.equal(rowsNoId.length, 2)
    } finally {
      historyClient2.close()
    }
  } finally {
    daemon?.close()
    liveClient?.close()
    historyClient?.close()
    child.kill('SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
})
