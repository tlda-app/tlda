#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WebSocket } from 'ws'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.resolve(HERE, '..')

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
        return reject(new Error(`waitFor timeout${suffix}`))
      }
      setTimeout(tick, interval)
    }
    tick()
  })
}

function openRegisteredWs(server, id, name) {
  return new Promise((resolve, reject) => {
    const wsBase = server.replace('https:', 'wss:').replace('http:', 'ws:')
    const ws = new WebSocket(`${wsBase}/ws/fleet`, { rejectUnauthorized: false })
    const reqId = `register-${Math.random().toString(36).slice(2)}`
    const timer = setTimeout(() => reject(new Error(`register timeout for ${id}`)), 5000)
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: reqId, type: 'register', agent_id: id, name }))
    })
    ws.on('message', raw => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg.id === reqId && msg.result?.ok && msg.result?.agent?.id === id) {
        clearTimeout(timer)
        resolve(ws)
      }
    })
    ws.on('error', reject)
  })
}

test('new registration for same fleet id evicts older fleet websocket', async () => {
  const tmp = path.join(tmpdir(), `fleet-ws-identity-${process.pid}-${Date.now()}`)
  const port = 5890 + Math.floor(Math.random() * 30)
  const serverUrl = `http://127.0.0.1:${port}`
  mkdirSync(tmp, { recursive: true })

  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    PROJECTS_DIR: path.join(tmp, 'projects'),
    TLDA_FLEET_DB: path.join(tmp, 'fleet.db'),
    TLDA_NO_AUTH: '1',
  }
  mkdirSync(env.PROJECTS_DIR, { recursive: true })
  mkdirSync(path.join(tmp, 'data'), { recursive: true })

  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'unified-server.mjs'), '--i-am-tlda-cli'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stdout.on('data', d => process.stderr.write(`[server] ${d}`))
  proc.stderr.on('data', d => process.stderr.write(`[server] ${d}`))

  try {
    await waitFor(() => fetch(`${serverUrl}/health`).then(r => r.ok).catch(() => false))

    const first = await openRegisteredWs(serverUrl, 'fleet:dupe', 'dupe')
    assert.equal(first.readyState, WebSocket.OPEN)
    let firstClosed = false
    first.on('close', () => { firstClosed = true })

    const second = await openRegisteredWs(serverUrl, 'fleet:dupe', 'dupe')
    await waitFor(() => firstClosed)

    assert.equal(second.readyState, WebSocket.OPEN)
    second.close()
  } finally {
    proc.kill('SIGTERM')
    rmSync(tmp, { recursive: true, force: true })
  }
})
