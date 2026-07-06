#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WebSocket } from 'ws'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.resolve(HERE, '..')
const hasLocalTls = existsSync(path.join(homedir(), '.config', 'tlda', 'localhost+2.pem')) &&
  existsSync(path.join(homedir(), '.config', 'tlda', 'localhost+2-key.pem'))

test('MCP combined spawn+delegate writes the delegate before attach/liveness polling', () => {
  const source = readFileSync(path.join(ROOT, 'mcp-server', 'fleet-tools.mjs'), 'utf8')
  const asyncBranch = source.slice(
    source.indexOf('if (spawnResult?.async)'),
    source.indexOf('return operationMailboxStartedResult(mailbox')
  )
  assert.match(asyncBranch, /delegateToResolvedAgent\(pendingAgentId,[\s\S]*allowPendingAgent: true/)
  assert.ok(
    asyncBranch.indexOf('delegateToResolvedAgent(pendingAgentId') < asyncBranch.indexOf('findSpawnedDelegateTarget'),
    'delegate must be persisted before waiting for spawned-agent liveness'
  )
  assert.doesNotMatch(asyncBranch, /delegateToResolvedAgent\(spawned\.id/)
})

function waitFor(predicate, { timeout = 8000, interval = 100, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout
    let lastError = null
    const tick = async () => {
      try {
        const value = await predicate()
        if (value) return resolve(value)
      } catch (e) {
        lastError = e
      }
      if (Date.now() > deadline) {
        const suffix = lastError ? `: ${lastError.message}` : ''
        reject(new Error(`waitFor timeout: ${label}${suffix}`))
        return
      }
      setTimeout(tick, interval)
    }
    tick()
  })
}

function rpc(ws, body, { timeout = 5000 } = {}) {
  const id = body.id || `rpc-${Math.random().toString(36).slice(2)}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`rpc timeout for ${body.type}`))
    }, timeout)
    const cleanup = () => {
      clearTimeout(timer)
      ws.off('message', onMessage)
      ws.off('error', onError)
    }
    const onMessage = raw => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg.id !== id) return
      cleanup()
      resolve(msg)
    }
    const onError = e => {
      cleanup()
      reject(e)
    }
    ws.on('message', onMessage)
    ws.on('error', onError)
    ws.send(JSON.stringify({ ...body, id }))
  })
}

async function openFleetWs(serverUrl) {
  const wsBase = serverUrl.replace('https:', 'wss:').replace('http:', 'ws:')
  const ws = new WebSocket(`${wsBase}/ws/fleet`, { rejectUnauthorized: false })
  await new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })
  return ws
}

async function openMockDaemon(serverUrl, machineId, capturedRpcs) {
  const wsBase = serverUrl.replace('https:', 'wss:').replace('http:', 'ws:')
  const ws = new WebSocket(`${wsBase}/ws/fleet-daemon`, { rejectUnauthorized: false })
  await new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })
  ws.on('message', raw => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    if (msg.type !== 'rpc') return
    capturedRpcs.push(msg)
    ws.send(JSON.stringify({ type: 'rpc-reply', id: msg.id, result: { ok: true, reason: 'spawning' } }))
  })
  ws.send(JSON.stringify({
    type: 'daemon-hello',
    machine_id: machineId,
    env_name: 'default',
    boot_id: Date.now(),
    user: 'test',
    hostname: machineId,
    version: 'test',
    install_path: ROOT,
  }))
  return ws
}

test('delegate can persist against a reserved spawn id before the spawned agent registers', async () => {
  const tmp = path.join(tmpdir(), `fleet-spawn-delegate-durable-${process.pid}-${Date.now()}`)
  const port = 6220 + Math.floor(Math.random() * 80)
  const serverUrl = `${hasLocalTls ? 'https' : 'http'}://127.0.0.1:${port}`
  const machineId = 'testbox-spawn-delegate-durable'
  const capturedRpcs = []
  mkdirSync(path.join(tmp, 'projects'), { recursive: true })
  mkdirSync(path.join(tmp, 'data'), { recursive: true })

  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    PROJECTS_DIR: path.join(tmp, 'projects'),
    TLDA_FLEET_DB: path.join(tmp, 'fleet.db'),
    TLDA_NO_AUTH: '1',
    TLDA_SPAWN_MAILBOX_DEADLINE_MS: '10000',
  }

  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'unified-server.mjs'), '--i-am-tlda-cli'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stdout.on('data', d => process.stderr.write(`[server] ${d}`))
  proc.stderr.on('data', d => process.stderr.write(`[server] ${d}`))

  let callerWs
  let spawnedWs
  let daemonWs
  try {
    await waitFor(() => fetch(`${serverUrl}/health`).then(r => r.ok).catch(() => false), { label: 'server health' })
    daemonWs = await openMockDaemon(serverUrl, machineId, capturedRpcs)
    callerWs = await openFleetWs(serverUrl)

    const owner = await rpc(callerWs, {
      type: 'register',
      agent_id: 'fleet:durable-owner',
      name: 'durable-owner',
      machine_id: machineId,
    })
    assert.equal(owner.result?.ok, true)

    const spawnReply = await rpc(callerWs, {
      type: 'spawn',
      fresh: true,
      name: 'durable-child',
      model: 'sonnet',
    })
    assert.equal(spawnReply.result?.ok, true, JSON.stringify(spawnReply))
    assert.equal(spawnReply.result.async, true)
    assert.ok(spawnReply.result.agent_id)

    await waitFor(
      () => capturedRpcs.find(msg => msg.op === 'spawn' && msg.agent_id === spawnReply.result.agent_id),
      { label: 'daemon spawn rpc' }
    )

    const delegateReply = await rpc(callerWs, {
      type: 'delegate',
      from: 'fleet:durable-owner',
      agent: spawnReply.result.agent_id,
      allow_pending_agent: true,
      description: 'Durable spawn delegate proof',
      message: 'This task must survive until registration.',
      success_criteria: ['inbox sees the task after register'],
    })
    assert.equal(delegateReply.result?.ok, true, JSON.stringify(delegateReply))
    assert.ok(delegateReply.result.task_id)

    const tasksBeforeRegister = await fetch(`${serverUrl}/api/store/tasks?active=false`).then(r => r.json())
    assert.equal(
      tasksBeforeRegister.find(t => t.id === delegateReply.result.task_id)?.agent,
      spawnReply.result.agent_id,
      'task row is durably bound to the reserved spawn id before registration'
    )

    spawnedWs = await openFleetWs(serverUrl)
    const spawnedRegister = await rpc(spawnedWs, {
      type: 'register',
      agent_id: spawnReply.result.agent_id,
      name: 'durable-child',
      machine_id: machineId,
      tmux_session: 'fleet-durable-child',
    })
    assert.equal(spawnedRegister.result?.ok, true)

    const inbox = await rpc(spawnedWs, {
      type: 'my-task',
      agent: spawnReply.result.agent_id,
      peek: true,
    })
    assert.equal(inbox.result?.task?.id, delegateReply.result.task_id)
    assert.equal(inbox.result.task.description, 'Durable spawn delegate proof')
    assert.match(inbox.result.task.message, /survive until registration/)
  } finally {
    callerWs?.close()
    spawnedWs?.close()
    daemonWs?.close()
    proc.kill('SIGTERM')
    rmSync(tmp, { recursive: true, force: true })
  }
})
