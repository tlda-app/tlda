#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { WebSocket } from 'ws'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.resolve(HERE, '..')

function waitFor(predicate, { timeout = 8000, interval = 100, name = 'condition' } = {}) {
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
        return reject(new Error(`waitFor timeout for ${name}${suffix}`))
      }
      setTimeout(tick, interval)
    }
    tick()
  })
}

function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

async function state(serverUrl) {
  return fetch(`${serverUrl}/api/state`).then(r => r.json())
}

test('terminal-dead immediately clears daemon liveness for the agent', async () => {
  const tmp = path.join(tmpdir(), `fleet-terminal-dead-${process.pid}-${Date.now()}`)
  const port = 5920 + Math.floor(Math.random() * 30)
  const serverUrl = `http://127.0.0.1:${port}`
  const machineId = `itest-machine-${process.pid}`
  const agentId = 'fleet:deadterm'

  mkdirSync(tmp, { recursive: true })
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: path.join(tmp, 'data'),
    PROJECTS_DIR: path.join(tmp, 'projects'),
    TLDA_FLEET_DB: path.join(tmp, 'fleet.db'),
    TLDA_NO_AUTH: '1',
  }
  mkdirSync(env.DATA_DIR, { recursive: true })
  mkdirSync(env.PROJECTS_DIR, { recursive: true })

  const proc = spawn(process.execPath, [path.join(ROOT, 'server', 'unified-server.mjs'), '--i-am-tlda-cli'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stdout.on('data', d => process.stderr.write(`[server] ${d}`))
  proc.stderr.on('data', d => process.stderr.write(`[server] ${d}`))

  try {
    await waitFor(() => fetch(`${serverUrl}/health`).then(r => r.ok).catch(() => false), { name: 'server health' })

    const fleetWs = await openWs(`ws://127.0.0.1:${port}/ws/fleet`)
    const daemonWs = await openWs(`ws://127.0.0.1:${port}/ws/fleet-daemon`)

    fleetWs.send(JSON.stringify({
      id: 'register-agent',
      type: 'register',
      agent_id: agentId,
      name: 'deadterm',
      tmux_session: 'fleet-deadterm',
      machine_id: machineId,
    }))
    daemonWs.send(JSON.stringify({
      type: 'daemon-hello',
      machine_id: machineId,
      user: 'test',
      hostname: 'test-host',
      version: 'test',
      boot_id: Date.now(),
      install_path: ROOT,
    }))

    await waitFor(async () => {
      const agent = (await state(serverUrl)).agents.find(a => a.id === agentId)
      return agent?.machine_id === machineId
    }, { name: 'registered agent' })

    daemonWs.send(JSON.stringify({
      type: 'agent-liveness',
      agent_ids: [agentId],
      checked_agent_ids: [agentId],
    }))
    await waitFor(async () => {
      const agent = (await state(serverUrl)).agents.find(a => a.id === agentId)
      return agent?.status === 'awake'
    }, { name: 'agent awake after liveness' })

    daemonWs.send(JSON.stringify({
      type: 'terminal-dead',
      agent_id: agentId,
      tmux_session: 'fleet-deadterm',
      exitCode: 127,
    }))
    await waitFor(async () => {
      const agent = (await state(serverUrl)).agents.find(a => a.id === agentId)
      return agent?.status === 'hibernating'
    }, { name: 'terminal-dead cleared liveness' })

    fleetWs.close()
    daemonWs.close()
  } finally {
    proc.kill('SIGTERM')
    rmSync(tmp, { recursive: true, force: true })
  }
})
