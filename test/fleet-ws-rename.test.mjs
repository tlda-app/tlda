#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Database from 'better-sqlite3'
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

test('WS rename uses FleetStore rename path and emits durable rename event', async () => {
  const tmp = path.join(tmpdir(), `fleet-ws-rename-${process.pid}-${Date.now()}`)
  const port = 5970 + Math.floor(Math.random() * 40)
  const serverUrl = `${hasLocalTls ? 'https' : 'http'}://127.0.0.1:${port}`
  const dbPath = path.join(tmp, 'fleet.db')
  mkdirSync(path.join(tmp, 'projects'), { recursive: true })
  mkdirSync(path.join(tmp, 'data'), { recursive: true })

  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    PROJECTS_DIR: path.join(tmp, 'projects'),
    TLDA_FLEET_DB: dbPath,
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

    const register = await rpc(ws, {
      type: 'register',
      agent_id: 'fleet:rename-ws',
      name: 'rename-ws-alpha',
    })
    assert.equal(register.result?.ok, true)

    const renamed = await rpc(ws, {
      type: 'rename',
      agent: 'rename-ws-alpha',
      name: 'rename-ws-bravo',
    })
    assert.equal(renamed.result?.ok, true)
    assert.deepEqual(renamed.result, { ok: true, agent: 'fleet:rename-ws', name: 'rename-ws-bravo' })

    await waitFor(async () => {
      const agents = await fetch(`${serverUrl}/api/store/agents`).then(r => r.json())
      return agents.some(a => a.id === 'fleet:rename-ws' && a.friendly_name === 'rename-ws-bravo')
    })

    const agents = await fetch(`${serverUrl}/api/store/agents`).then(r => r.json())
    assert.equal(agents.find(a => a.friendly_name === 'rename-ws-alpha'), undefined)
    assert.equal(agents.find(a => a.id === 'fleet:rename-ws')?.friendly_name, 'rename-ws-bravo')

    await waitFor(() => {
      const db = new Database(dbPath, { readonly: true })
      try {
        const event = db.prepare(`
          SELECT type, agent_id, metadata FROM events
          WHERE type = 'lifecycle' AND agent_id = ?
          ORDER BY id DESC LIMIT 1
        `).get('fleet:rename-ws')
        if (!event) return false
        const metadata = JSON.parse(event.metadata)
        return metadata.subtype === 'rename' &&
          metadata.oldName === 'rename-ws-alpha' &&
          metadata.newName === 'rename-ws-bravo' &&
          metadata.reason === 'ws-rename'
      } finally {
        db.close()
      }
    })
  } finally {
    ws?.close()
    proc.kill('SIGTERM')
    rmSync(tmp, { recursive: true, force: true })
  }
})
