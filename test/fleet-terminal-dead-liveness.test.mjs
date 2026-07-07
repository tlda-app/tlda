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

function nextDaemonRpc(ws, op) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error(`timeout waiting for daemon rpc ${op}`))
    }, 5000)
    function onMessage(raw) {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg.type !== 'rpc' || msg.op !== op) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(msg)
    }
    ws.on('message', onMessage)
  })
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
    TLDA_TLS_CERT: '/tmp/tlda-no-cert.pem',
    TLDA_TLS_KEY: '/tmp/tlda-no-key.pem',
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
      env_name: 'default',
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

test('wake nudge treats daemon check-alive alive boolean as alive state', async () => {
  const tmp = path.join(tmpdir(), `fleet-wake-alive-${process.pid}-${Date.now()}`)
  const port = 5960 + Math.floor(Math.random() * 30)
  const serverUrl = `http://127.0.0.1:${port}`
  const machineId = `itest-wake-machine-${process.pid}`
  const agentId = 'fleet:wakealive'

  mkdirSync(tmp, { recursive: true })
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: path.join(tmp, 'data'),
    PROJECTS_DIR: path.join(tmp, 'projects'),
    TLDA_FLEET_DB: path.join(tmp, 'fleet.db'),
    TLDA_NO_AUTH: '1',
    TLDA_TLS_CERT: '/tmp/tlda-no-cert.pem',
    TLDA_TLS_KEY: '/tmp/tlda-no-key.pem',
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
      name: 'wakealive',
      tmux_session: 'fleet-wakealive',
      machine_id: machineId,
      env_name: 'default',
      metadata: { deliveryChannel: 'tmux', kind: 'claude' },
    }))
    daemonWs.send(JSON.stringify({
      type: 'daemon-hello',
      machine_id: machineId,
      env_name: 'default',
      user: 'test',
      hostname: 'test-host',
      version: 'test',
      boot_id: Date.now(),
      install_path: ROOT,
    }))

    await waitFor(async () => {
      const agent = (await state(serverUrl)).agents.find(a => a.id === agentId)
      return agent?.machine_id === machineId && agent?.env_name === 'default'
    }, { name: 'registered wake agent' })

    daemonWs.send(JSON.stringify({
      type: 'agent-liveness',
      agent_ids: [agentId],
      checked_agent_ids: [agentId],
    }))
    await waitFor(async () => {
      const agent = (await state(serverUrl)).agents.find(a => a.id === agentId)
      return agent?.status === 'awake'
    }, { name: 'wake agent awake after liveness' })

    const checkAlive = nextDaemonRpc(daemonWs, 'check-alive')
    fleetWs.send(JSON.stringify({
      id: 'chat-wake',
      type: 'chat',
      from: 'fleet:skip',
      to: 'wakealive',
      message: `wake integration ${Date.now()}`,
    }))

    const checkMsg = await checkAlive
    assert.equal(checkMsg.tmux_session, 'fleet-wakealive')
    const sendText = nextDaemonRpc(daemonWs, 'send-text')
    daemonWs.send(JSON.stringify({
      type: 'rpc-reply',
      id: checkMsg.id,
      result: { alive: true },
    }))
    const sendMsg = await sendText
    assert.equal(sendMsg.tmux_session, 'fleet-wakealive')
    assert.match(sendMsg.text, /message arrived/)

    daemonWs.send(JSON.stringify({
      type: 'rpc-reply',
      id: sendMsg.id,
      result: { ok: true },
    }))

    fleetWs.close()
    daemonWs.close()
  } finally {
    proc.kill('SIGTERM')
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('api kill-session hibernates the agent instead of marking it dead', async () => {
  const tmp = path.join(tmpdir(), `fleet-kill-session-${process.pid}-${Date.now()}`)
  const port = 5920 + Math.floor(Math.random() * 30)
  const serverUrl = `http://127.0.0.1:${port}`
  const machineId = `itest-machine-${process.pid}`
  const envName = 'default'
  const agentId = 'fleet:killsession'

  mkdirSync(tmp, { recursive: true })
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: path.join(tmp, 'data'),
    PROJECTS_DIR: path.join(tmp, 'projects'),
    TLDA_FLEET_DB: path.join(tmp, 'fleet.db'),
    TLDA_NO_AUTH: '1',
    TLDA_TLS_CERT: '/tmp/tlda-no-cert.pem',
    TLDA_TLS_KEY: '/tmp/tlda-no-key.pem',
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
      name: 'killsession',
      tmux_session: 'fleet-killsession',
      machine_id: machineId,
      env_name: envName,
    }))
    daemonWs.send(JSON.stringify({
      type: 'daemon-hello',
      machine_id: machineId,
      env_name: envName,
      user: 'test',
      hostname: 'test-host',
      version: 'test',
      boot_id: Date.now(),
      install_path: ROOT,
    }))

    await waitFor(async () => {
      const agent = (await state(serverUrl)).agents.find(a => a.id === agentId)
      return agent?.status === 'awake' && agent?.dead === false
    }, { name: 'registered awake agent' })

    const rpcPromise = nextDaemonRpc(daemonWs, 'kill-session')
    const killPromise = fetch(`${serverUrl}/api/kill-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: agentId }),
    }).then(r => r.json())
    const rpc = await rpcPromise
    assert.equal(rpc.agent_id, agentId)
    assert.equal(rpc.tmux_session, 'fleet-killsession')
    daemonWs.send(JSON.stringify({
      type: 'rpc-reply',
      id: rpc.id,
      result: { ok: true, tmux_session: rpc.tmux_session },
    }))
    assert.equal((await killPromise).ok, true)

    await waitFor(async () => {
      const agent = (await state(serverUrl)).agents.find(a => a.id === agentId)
      return agent?.status === 'hibernating' && agent?.dead === false
    }, { name: 'kill-session hibernated agent' })

    fleetWs.close()
    daemonWs.close()
  } finally {
    proc.kill('SIGTERM')
    rmSync(tmp, { recursive: true, force: true })
  }
})
