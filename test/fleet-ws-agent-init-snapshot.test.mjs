#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
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
        reject(new Error(`waitFor timeout${suffix}`))
        return
      }
      setTimeout(tick, interval)
    }
    tick()
  })
}

function nextJson(ws, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('message timeout'))
    }, timeout)
    const cleanup = () => {
      clearTimeout(timer)
      ws.off('message', onMessage)
      ws.off('error', onError)
    }
    const onMessage = (raw) => {
      cleanup()
      try { resolve(JSON.parse(raw.toString())) }
      catch (e) { reject(e) }
    }
    const onError = (e) => {
      cleanup()
      reject(e)
    }
    ws.on('message', onMessage)
    ws.on('error', onError)
  })
}

function openWs(url) {
  const ws = new WebSocket(url, { rejectUnauthorized: false })
  const ready = new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
  })
  return { ws, ready }
}

test('fleet WS sends initial roster snapshot only to browser sockets', async () => {
  const tmp = path.join(tmpdir(), `fleet-ws-init-${process.pid}-${Date.now()}`)
  const port = 5930 + Math.floor(Math.random() * 40)
  const serverUrl = `https://127.0.0.1:${port}`
  const wsBase = `wss://127.0.0.1:${port}`
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

    const browser = openWs(`${wsBase}/ws/fleet`)
    await browser.ready
    const browserFirst = await nextJson(browser.ws)
    assert.ok(Array.isArray(browserFirst.agents), 'browser socket gets initial agents snapshot')
    assert.ok(Array.isArray(browserFirst.tasks), 'browser socket gets initial tasks snapshot')
    browser.ws.close()

    const agent = openWs(`${wsBase}/ws/fleet?agent=${encodeURIComponent('fleet:init-snapshot-test')}`)
    await agent.ready
    const reqId = crypto.randomUUID()
    agent.ws.send(JSON.stringify({
      id: reqId,
      type: 'register',
      agent_id: 'fleet:init-snapshot-test',
      name: 'init-snapshot-test',
    }))
    const agentFirst = await nextJson(agent.ws)
    assert.equal(agentFirst.id, reqId, 'agent socket first message is its RPC reply, not a full init snapshot')
    assert.equal(agentFirst.result?.ok, true)
    assert.equal(agentFirst.result?.agent?.id, 'fleet:init-snapshot-test')
    assert.equal(agentFirst.agents, undefined)
    assert.equal(agentFirst.tasks, undefined)
    agent.ws.close()
  } finally {
    proc.kill('SIGTERM')
    rmSync(tmp, { recursive: true, force: true })
  }
})
