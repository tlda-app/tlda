import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import WebSocket from 'ws'

import { parseCodexRecord } from '../../agent-runtime/codex-activity.mjs'
import { createActivityExtractor } from '../../agent-runtime/jsonl-event-extract.mjs'
import { sendActivityEvents } from '../../agent-runtime/activity-send.mjs'
import { convertChatEvent } from '../../src/fleet/convert-chat-event.mjs'
import { renderActivityGroup } from '../../src/fleet/activity-render.mjs'
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
    type: 'subscribe-filter',
    subId,
    filter: [[['from', agentId]]],
    window: 20,
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

test('unknown Codex result crosses daemon websocket, persistence, subscription, and renderer DOM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-unknown-tool-wire-'))
  const dbPath = join(dir, 'fleet.db')
  const agentId = 'fleet:unknown-tool-wire'
  const store = new FleetStore(dbPath, { taskDoc: false })
  await store.upsertAgent({
    id: agentId,
    friendly_name: 'unknown-tool-wire',
    labels: [],
    registered_at: '2026-08-14T00:00:00.000Z',
    last_seen: '2026-08-14T00:00:00.000Z',
    dead: false,
    human: false,
  })
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

  let daemon
  let liveClient
  let historyClient
  try {
    await waitForServer(child)
    const base = `wss://127.0.0.1:${port}`
    liveClient = await openSocket(`${base}/ws/fleet`)
    subscribe(liveClient, 'unknown-live', agentId)
    daemon = await openSocket(`${base}/ws/fleet-daemon`)
    daemon.send(JSON.stringify({
      type: 'daemon-hello',
      machine_id: 'wire-machine',
      env_name: 'test',
      daemon_key: 'wire-machine:test',
      boot_id: 'unknown-wire-boot',
      user: 'test',
      hostname: 'wire-machine',
      version: 'test',
    }))

    const ts = '2026-08-14T00:00:01.000Z'
    const call = parseCodexRecord({
      timestamp: ts,
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'future_native_tool',
        arguments: JSON.stringify({ target: 'paper.tex', mode: 'inspect' }),
        call_id: 'call_unknown_wire',
      },
    })
    const output = parseCodexRecord({
      timestamp: ts,
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_unknown_wire',
        output: 'first line\nsecond line\nthird line\nfourth line',
      },
    })
    const [activity] = createActivityExtractor().extractActivityEvents([call, output])
    const livePromise = waitForSubscriptionEvent(
      liveClient,
      'unknown-live',
      event => event.type === 'activity' && event.text === 'future_native_tool',
    )
    assert.equal(sendActivityEvents(agentId, [activity], message => {
      daemon.send(JSON.stringify(message))
      return true
    }), true)
    const liveEvent = await livePromise
    assert.equal(liveEvent.metadata.prettyResult, activity.prettyResult)

    liveClient.close()
    liveClient = null
    historyClient = await openSocket(`${base}/ws/fleet`)
    const historyPromise = waitForSubscriptionEvent(
      historyClient,
      'unknown-history',
      event => event.type === 'activity' && event.text === 'future_native_tool',
    )
    subscribe(historyClient, 'unknown-history', agentId)
    const persistedEvent = await historyPromise
    assert.ok(Number(persistedEvent.id) > 0)
    const persistedMetadata = typeof persistedEvent.metadata === 'string'
      ? JSON.parse(persistedEvent.metadata)
      : persistedEvent.metadata
    assert.equal(persistedMetadata.prettyResult, activity.prettyResult)
    assert.equal(persistedMetadata.input._unknownCodexToolKind, 'future_native_tool')

    const item = convertChatEvent(persistedEvent)
    assert.equal(item._prettyResult, activity.prettyResult)
    const html = renderActivityGroup([item], {
      agentLabel: () => 'unknown-tool-wire',
      getNickClass: () => '',
      getAgents: () => [],
      renderMarkdown: value => value,
      highlightSyntax: value => value,
      langFromFilePath: () => '',
      foldHeights: { toolMarkdown: 2 },
    })
    const document = new JSDOM(html).window.document
    const result = document.querySelector('.tool-pretty-result.tool-pretty-markdown')
    assert.ok(result)
    assert.equal(result.querySelector('.fold-body').textContent, activity.prettyResult)
    assert.equal(result.querySelector('.fold-body').classList.contains('code-collapsed'), true)
    assert.match(result.querySelector('.code-block-toggle').textContent, /4 lines — show all/)
  } finally {
    daemon?.close()
    liveClient?.close()
    historyClient?.close()
    child.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})
