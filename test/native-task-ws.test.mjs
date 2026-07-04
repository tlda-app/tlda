import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import WebSocket from 'ws'

import { createNativeTaskState } from '../bin/lib/native-task-events.mjs'
import { extractRecordOutputsWithState } from '../bin/fleet-jsonl-ingester.mjs'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function claudeCreateRecords() {
  const input = {
    subject: 'Native inbox proof',
    description: 'This native task should appear first in my-task.',
    activeForm: 'checking native inbox proof',
  }
  return [
    {
      type: 'assistant',
      timestamp: '2026-07-04T13:00:00.000Z',
      message: { content: [{ type: 'tool_use', id: 'tool-create-1', name: 'TaskCreate', input }] },
    },
    {
      type: 'user',
      timestamp: '2026-07-04T13:00:01.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-create-1', content: 'Task #2 created' }] },
      toolUseResult: { task: { id: '2', subject: input.subject } },
    },
  ]
}

function claudeCompleteRecord() {
  return {
    type: 'assistant',
    timestamp: '2026-07-04T13:02:00.000Z',
    message: {
      content: [{
        type: 'tool_use',
        id: 'tool-update-1',
        name: 'TaskUpdate',
        input: { taskId: '2', status: 'completed' },
      }],
    },
  }
}

function connectWs(url, wsOpts) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, wsOpts)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

function cleanup(label, fn) {
  try {
    fn()
  } catch (e) {
    // Best-effort cleanup after test assertions; report without masking the primary result.
    console.warn(`[native-task-ws] cleanup failed for ${label}: ${e.message}`)
  }
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

async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 100 } = {}) {
  const start = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await sleep(intervalMs)
  }
}

test('Claude native task records flow through daemon WS to my-task and drop from active on completion', async () => {
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '..')
  const port = 5207
  const db = path.join(os.tmpdir(), `native-task-ws-${process.pid}.db`)
  const projects = path.join(os.tmpdir(), `native-task-projects-${process.pid}`)
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
  let daemon
  try {
    await waitFor(async () => {
      try {
        const res = await fetch(`${proto}://127.0.0.1:${port}/api/health`)
        return res.ok
      } catch {
        return false
      }
    }, { timeoutMs: 30000, intervalMs: 250 })

    fleet = await connectWs(`${wsProto}://127.0.0.1:${port}/ws/fleet`, wsOpts)
    const sendFleet = fleetRpc(fleet)
    const registered = await sendFleet('register', { agent_id: 'fleet:native-test', name: 'native-test' })
    assert.equal(registered?.ok, true)
    const agents = await sendFleet('store-agents')
    assert.ok(agents.some(agent => agent.id === 'fleet:native-test'))

    daemon = await connectWs(`${wsProto}://127.0.0.1:${port}/ws/fleet-daemon`, wsOpts)
    daemon.send(JSON.stringify({
      type: 'daemon-hello',
      machine_id: 'native-test-machine',
      env_name: 'native-test-env',
      boot_id: Date.now(),
      user: 'test',
      hostname: 'native-test',
      version: 'test',
    }))
    await sleep(300)

    const base = { agentId: 'fleet:native-test', sessionId: 'sess-native', harnessKind: 'claude', terminalChat: false, backfillSearch: false }
    const nativeState = createNativeTaskState()
    const createEvents = claudeCreateRecords()
      .flatMap(record => extractRecordOutputsWithState(base, record, nativeState))
      .filter(output => output.type === 'nativeTask')
      .flatMap(output => output.events)
    assert.equal(createEvents.length, 1)
    daemon.send(JSON.stringify({
      type: 'native-task-event',
      agent_id: 'fleet:native-test',
      harness: 'claude',
      session_id: 'sess-native',
      source_path: '/tmp/native-session.jsonl',
      events: createEvents,
    }))

    const activeWithNative = await waitFor(async () => {
      const data = await sendFleet('my-task', { agent: 'fleet:native-test', peek: true })
      const first = data?.tasks?.[0]
      return first?.metadata?.native ? data : null
    })
    assert.equal(activeWithNative.tasks[0].id, 'native:claude:fleet:native-test:sess-native:2')
    assert.match(activeWithNative.tasks[0].message, /Native task in Claude Code/)
    assert.match(activeWithNative.tasks[0].message, /Subject: Native inbox proof/)

    const completeEvents = extractRecordOutputsWithState(base, claudeCompleteRecord(), nativeState)
      .filter(output => output.type === 'nativeTask')
      .flatMap(output => output.events)
    assert.equal(completeEvents.length, 1)
    daemon.send(JSON.stringify({
      type: 'native-task-event',
      agent_id: 'fleet:native-test',
      harness: 'claude',
      session_id: 'sess-native',
      source_path: '/tmp/native-session.jsonl',
      events: completeEvents,
    }))

    await waitFor(async () => {
      const data = await sendFleet('my-task', { agent: 'fleet:native-test', peek: true })
      return Array.isArray(data?.tasks) && !data.tasks.some(t => t.metadata?.native)
    })
    const allTasks = await sendFleet('store-tasks', { active: false })
    const history = allTasks.find(t => t.id === 'native:claude:fleet:native-test:sess-native:2')
    assert.equal(history.status, 'done')
    assert.equal(history.metadata.native, true)
  } catch (e) {
    e.message = `${e.message}\nserver log:\n${serverLog.slice(-2000)}`
    throw e
  } finally {
    cleanup('fleet ws', () => fleet?.close())
    cleanup('daemon ws', () => daemon?.close())
    cleanup('server process', () => server.kill('SIGKILL'))
    cleanup('projects dir', () => fs.rmSync(projects, { recursive: true, force: true }))
    cleanup('db', () => fs.rmSync(db, { force: true }))
    cleanup('db wal', () => fs.rmSync(`${db}-wal`, { force: true }))
    cleanup('db shm', () => fs.rmSync(`${db}-shm`, { force: true }))
  }
})
