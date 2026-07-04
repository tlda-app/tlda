#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WebSocket } from 'ws'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.resolve(HERE, '..')
const hasLocalTls = existsSync(path.join(homedir(), '.config', 'tlda', 'localhost+2.pem')) &&
  existsSync(path.join(homedir(), '.config', 'tlda', 'localhost+2-key.pem'))

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
    ws.send(JSON.stringify({ type: 'rpc-reply', id: msg.id, result: { ok: true, mock: true } }))
  })
  ws.send(JSON.stringify({
    type: 'daemon-hello',
    machine_id: machineId,
    boot_id: Date.now(),
    user: 'test',
    hostname: machineId,
    version: 'test',
  }))
  return ws
}

function parseMetadata(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return {} }
}

test('fresh spawn collision registers variant and completes mailbox with assigned name', async () => {
  const tmp = path.join(tmpdir(), `fleet-spawn-mailbox-collision-${process.pid}-${Date.now()}`)
  const port = 6060 + Math.floor(Math.random() * 40)
  const serverUrl = `${hasLocalTls ? 'https' : 'http'}://127.0.0.1:${port}`
  const machineId = 'testbox-spawn-mailbox'
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
    TLDA_SPAWN_REGISTER_DEADLINE_MS: '5000',
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
      agent_id: 'fleet:proof-owner',
      name: 'proof-owner',
      machine_id: machineId,
    })
    assert.equal(owner.result?.ok, true)

    const incumbent = await rpc(callerWs, {
      type: 'register',
      agent_id: 'fleet:incumbent-beta',
      name: 'beta',
      machine_id: machineId,
    })
    assert.equal(incumbent.result?.ok, true)
    assert.equal(incumbent.result.assigned_name, 'beta')

    const spawnReply = await rpc(callerWs, {
      type: 'spawn',
      fresh: true,
      name: 'beta',
      model: 'sonnet',
    })
    assert.equal(spawnReply.result?.ok, true)
    assert.equal(spawnReply.result.async, true)
    assert.equal(spawnReply.result.name, 'beta')
    assert.ok(spawnReply.result.mailbox_id)
    assert.ok(spawnReply.result.agent_id)

    const spawnRpc = await waitFor(
      () => capturedRpcs.find(msg => msg.op === 'spawn' && msg.agent_id === spawnReply.result.agent_id),
      { label: 'daemon spawn rpc' }
    )
    assert.equal(spawnRpc.name, 'beta')
    assert.equal(spawnRpc.friendly_name, 'beta')
    assert.equal(spawnRpc.respawn, false)
    assert.equal(spawnRpc.agent_id, spawnReply.result.agent_id)

    spawnedWs = await openFleetWs(serverUrl)
    const spawnedRegister = await rpc(spawnedWs, {
      type: 'register',
      agent_id: spawnReply.result.agent_id,
      name: 'beta',
      machine_id: machineId,
      tmux_session: 'fleet-proof-beta',
    })
    assert.equal(spawnedRegister.result?.ok, true)
    assert.equal(spawnedRegister.result.requested_name, 'beta')
    assert.equal(spawnedRegister.result.assigned_name, 'aeta')
    assert.equal(spawnedRegister.result.name_changed, true)
    assert.equal(spawnedRegister.result.agent.friendly_name, 'aeta')

    let completion
    try {
      completion = await waitFor(async () => {
        const json = await fetch(`${serverUrl}/api/store/events?type=chat&limit=200`).then(r => r.json())
        return (json.events || []).find(event => {
          const metadata = parseMetadata(event.metadata)
          return metadata.type === 'mailbox_complete' &&
            metadata.mailbox_id === spawnReply.result.mailbox_id &&
            metadata.status === 'completed'
        })
      }, { label: 'mailbox completion event' })
    } catch (e) {
      const json = await fetch(`${serverUrl}/api/store/events?type=chat&limit=200`).then(r => r.json())
      const mailboxEvents = (json.events || []).map(event => ({
        id: event.id,
        from: event.from,
        to: event.to,
        text: event.text,
        metadata: parseMetadata(event.metadata),
      })).filter(event => event.metadata?.type === 'mailbox_complete')
      assert.fail(`${e.message}; mailbox events: ${JSON.stringify(mailboxEvents)}`)
    }
    const metadata = parseMetadata(completion.metadata)
    assert.equal(metadata.agentId, spawnReply.result.agent_id)
    assert.equal(metadata.requested_name, 'beta')
    assert.equal(metadata.assigned_name, 'aeta')
    assert.equal(metadata.name_changed, true)

    const agents = await fetch(`${serverUrl}/api/store/agents`).then(r => r.json())
    assert.equal(agents.find(a => a.id === 'fleet:incumbent-beta')?.friendly_name, 'beta')
    assert.equal(agents.find(a => a.id === spawnReply.result.agent_id)?.friendly_name, 'aeta')
  } finally {
    callerWs?.close()
    spawnedWs?.close()
    daemonWs?.close()
    proc.kill('SIGTERM')
    rmSync(tmp, { recursive: true, force: true })
  }
})
