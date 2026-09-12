// A region transfer draws its diff from the tool RESULT, not from the call's
// arguments — `regionTransferEditInput` parses the ```diff block out of
// `_prettyResult`. So the card exists only if the result survives the trip from
// the agent's transcript to the browser, and a renderer test that builds the
// activity event in-process never touches that trip.
//
// This crosses it: real MCP dispatch -> harness extraction -> daemon websocket
// -> server -> fleet store -> subscription -> convertChatEvent -> renderer DOM.
// Same harness as unknown-codex-tool-wire.test.mjs, which is the positive
// control for the transport itself.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import WebSocket from 'ws'

import { createActivityExtractor, parseSessionRecord } from '../../agent-runtime/jsonl-event-extract.mjs'
import { sendActivityEvents } from '../../agent-runtime/activity-send.mjs'
import { convertChatEvent } from '../../src/fleet/convert-chat-event.mjs'
import { renderActivityGroup } from '../../src/fleet/activity-render.mjs'
import { FleetStore } from './fleet-store.mjs'

const { handleFleetTool } = await import('../../mcp-server/fleet-tools.mjs')

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

const RENDER_CTX = {
  agentLabel: id => id,
  getNickClass: () => '',
  getAgents: () => [],
  getTasks: () => [],
  renderMarkdown: html => html,
  langFromFilePath: () => '',
  highlightSyntax: code => code,
  preambleMacros: {},
}

test('a region transfer card crosses the daemon wire with the diff it is made of', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-region-transfer-wire-'))
  const dbPath = join(dir, 'fleet.db')
  const agentId = 'fleet:region-transfer-wire'
  const store = new FleetStore(dbPath, { taskDoc: false })
  await store.upsertAgent({
    id: agentId,
    friendly_name: 'region-transfer-wire',
    labels: [],
    registered_at: '2026-09-12T00:00:00.000Z',
    last_seen: '2026-09-12T00:00:00.000Z',
    dead: false,
    human: false,
  })
  store.close()

  const sourceFile = join(dir, 'staging.md')
  const targetFile = join(dir, 'chapter.tex')
  writeFileSync(sourceFile, 'heading\nthe transferred first line\nthe transferred second line\ntail\n')
  writeFileSync(targetFile, 'preamble\nthe original first line\nthe original second line\nclosing\n')
  const input = {
    source_file: sourceFile,
    source_start_line: 2,
    source_end_line: 3,
    target_file: targetFile,
    target_start_line: 2,
    target_end_line: 3,
    expected: 'the original first line\nthe original second line',
  }
  const response = await handleFleetTool('region_transfer', input)
  const resultText = response.content.map(part => part.text || '').join('')
  assert.match(resultText, /```diff/, 'dispatch must return the diff the card is made of')

  const ts = '2026-09-12T00:00:01.000Z'
  const call = parseSessionRecord({
    type: 'assistant',
    timestamp: ts,
    message: {
      content: [{
        type: 'tool_use',
        name: 'mcp__tlda__region_transfer',
        id: 'toolu_region_transfer_wire',
        input,
      }],
    },
  })
  const toolResult = parseSessionRecord({
    type: 'user',
    timestamp: ts,
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'toolu_region_transfer_wire', content: resultText }],
    },
  })
  const activity = createActivityExtractor().extractActivityEvents([call, toolResult])
    .find(evt => evt.tool === 'tlda/region_transfer')
  assert.ok(activity, 'the harness extractor must emit a region_transfer activity event')
  assert.match(activity.prettyResult || '', /```diff/, 'the extracted event must carry the diff')

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
    subscribe(liveClient, 'region-transfer-live', agentId)
    daemon = await openSocket(`${base}/ws/fleet-daemon`)
    daemon.send(JSON.stringify({
      type: 'daemon-hello',
      machine_id: 'wire-machine',
      env_name: 'test',
      daemon_key: 'wire-machine:test',
      boot_id: 'region-transfer-wire-boot',
      user: 'test',
      hostname: 'wire-machine',
      version: 'test',
    }))

    const livePromise = waitForSubscriptionEvent(
      liveClient,
      'region-transfer-live',
      event => event.type === 'activity' && event.text === 'tlda/region_transfer',
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
      'region-transfer-history',
      event => event.type === 'activity' && event.text === 'tlda/region_transfer',
    )
    subscribe(historyClient, 'region-transfer-history', agentId)
    const persistedEvent = await historyPromise
    assert.ok(Number(persistedEvent.id) > 0)

    const item = convertChatEvent(persistedEvent)
    assert.equal(item._prettyResult, activity.prettyResult)
    const document = new JSDOM(renderActivityGroup([item], RENDER_CTX)).window.document

    assert.equal(document.querySelector('.tool-name')?.textContent, 'tlda/region_transfer')
    assert.ok(document.querySelector('.tool-line.has-diff'), 'the card is a diff card')
    assert.match(
      document.querySelector('.edit-diff-wrap .diff-old')?.textContent || '',
      /the original first line/,
      'the removed side shows the bytes that left the target',
    )
    assert.match(
      document.querySelector('.edit-diff-wrap .diff-new')?.textContent || '',
      /the transferred first line/,
      'the added side shows the bytes copied in from the staging file',
    )
    assert.equal(document.querySelector('.pretty-result'), null, 'and nothing restates it underneath')

    // The narrow half: a thread card re-reads its messages from the store when
    // it draws, so its result must NOT ride along. If this ever arrives, the
    // ingest has gone back to carrying everything.
    const threadPromise = waitForSubscriptionEvent(
      historyClient,
      'region-transfer-history',
      event => event.type === 'activity' && event.text === 'tlda/thread',
    )
    assert.equal(sendActivityEvents(agentId, [{
      tool: 'tlda/thread',
      arg: 'skip',
      ts: '2026-09-12T00:00:02.000Z',
      id: 'toolu_thread_wire',
      input: { agent: 'skip' },
      status: 'completed',
      prettyResult: 'THREAD RESULT',
    }], message => {
      daemon.send(JSON.stringify(message))
      return true
    }), true)
    const threadEvent = await threadPromise
    assert.equal(threadEvent.metadata.prettyResult, undefined)
  } finally {
    daemon?.close()
    liveClient?.close()
    historyClient?.close()
    child.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})
