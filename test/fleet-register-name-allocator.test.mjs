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

function waitFor(predicate, { timeout = 8000, interval = 100 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout
    let lastError = null
    const tick = async () => {
      try {
        if (await predicate()) return resolve(true)
      } catch (e) {
        lastError = e
      }
      if (Date.now() > deadline) {
        const suffix = lastError ? `: ${lastError.message}` : ''
        reject(new Error(`waitFor timeout${suffix}`))
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

async function openWs(serverUrl) {
  const wsBase = serverUrl.replace('https:', 'wss:').replace('http:', 'ws:')
  const ws = new WebSocket(`${wsBase}/ws/fleet`, { rejectUnauthorized: false })
  await new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })
  return ws
}

test('fresh register collision receives assigned variant instead of bouncing', async () => {
  const tmp = path.join(tmpdir(), `fleet-register-name-${process.pid}-${Date.now()}`)
  const port = 6020 + Math.floor(Math.random() * 40)
  const serverUrl = `${hasLocalTls ? 'https' : 'http'}://127.0.0.1:${port}`
  mkdirSync(path.join(tmp, 'projects'), { recursive: true })
  mkdirSync(path.join(tmp, 'data'), { recursive: true })

  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    PROJECTS_DIR: path.join(tmp, 'projects'),
    TLDA_FLEET_DB: path.join(tmp, 'fleet.db'),
    TLDA_NO_AUTH: '1',
  }

  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'unified-server.mjs'), '--i-am-tlda-cli'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stdout.on('data', d => process.stderr.write(`[server] ${d}`))
  proc.stderr.on('data', d => process.stderr.write(`[server] ${d}`))

  let ws
  try {
    await waitFor(() => fetch(`${serverUrl}/health`).then(r => r.ok).catch(() => false))
    ws = await openWs(serverUrl)

    const first = await rpc(ws, {
      type: 'register',
      agent_id: 'fleet:name-a',
      name: 'beta',
    })
    assert.equal(first.result?.ok, true)
    assert.equal(first.result.assigned_name, 'beta')
    assert.equal(first.result.requested_name, 'beta')
    assert.equal(first.result.name_changed, false)
    assert.equal(first.result.agent.friendly_name, 'beta')

    const second = await rpc(ws, {
      type: 'register',
      agent_id: 'fleet:name-b',
      name: 'beta',
    })
    assert.equal(second.result?.ok, true)
    assert.equal(second.result.requested_name, 'beta')
    assert.equal(second.result.assigned_name, 'aeta')
    assert.equal(second.result.name_changed, true)
    assert.equal(second.result.agent.friendly_name, 'aeta')

    const reregister = await rpc(ws, {
      type: 'register',
      agent_id: 'fleet:name-a',
      name: 'gamma',
    })
    assert.equal(reregister.result?.ok, true)
    assert.equal(reregister.result.requested_name, 'gamma')
    assert.equal(reregister.result.assigned_name, 'beta')
    assert.equal(reregister.result.name_changed, true)
    assert.equal(reregister.result.agent.friendly_name, 'beta')

    const updateCollision = await rpc(ws, {
      type: 'update-agent',
      agent: { id: 'fleet:name-b', friendly_name: 'beta' },
    })
    assert.match(String(updateCollision.error), /unavailable|collides/)

    const agents = await fetch(`${serverUrl}/api/store/agents`).then(r => r.json())
    assert.equal(agents.find(a => a.id === 'fleet:name-a')?.friendly_name, 'beta')
    assert.equal(agents.find(a => a.id === 'fleet:name-b')?.friendly_name, 'aeta')
  } finally {
    if (ws) ws.close()
    proc.kill('SIGTERM')
    rmSync(tmp, { recursive: true, force: true })
  }
})
