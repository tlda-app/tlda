// The daemon decides process liveness; the server writes down what it is told.
//
// A `process-liveness` verdict from the daemon flips the roster status with no
// server-side interpretation: alive means a confirmed process, false means a
// confirmed absence. Asserted over a real daemon socket against a real server,
// reading the status the roster would show.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import https from 'node:https'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'

import { FleetStore } from './fleet-store.mjs'
import { removeTempDir } from './test-support/remove-temp-dir.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { rejectUnauthorized: false }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) { reject(new Error(`HTTP ${res.statusCode}: ${body}`)); return }
        try { resolve(JSON.parse(body)) } catch (e) { reject(e) }
      })
    })
    req.once('error', reject)
  })
}

async function unusedPort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function startServer({ dir, dbPath, port }) {
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
  let output = ''
  child.stdout.on('data', c => { output += c })
  child.stderr.on('data', c => { output += c })
  const deadline = Date.now() + 90_000
  while (!output.includes('Unified server running')) {
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}: ${output}`)
    if (Date.now() >= deadline) throw new Error(`server did not start: ${output}`)
    await sleep(25)
  }
  return child
}

async function openDaemon(port) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws/fleet-daemon`, { rejectUnauthorized: false })
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  const welcome = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('daemon welcome timed out')), 20_000)
    const onMessage = raw => {
      if (JSON.parse(String(raw)).type !== 'daemon-welcome') return
      clearTimeout(timeout)
      ws.off('message', onMessage)
      resolve()
    }
    ws.on('message', onMessage)
  })
  ws.send(JSON.stringify({
    type: 'daemon-hello', machine_id: 'liveness-wire', env_name: 'test',
    boot_id: 1, install_path: import.meta.dirname, hostname: 'test', version: 'test',
  }))
  await welcome
  return ws
}

async function runtimeStatus(port, agentId) {
  const data = await getJson(`https://127.0.0.1:${port}/api/agents/lookup?ids=${encodeURIComponent(agentId)}`)
  return data?.agents?.[0]?.runtime_status?.status || null
}

async function waitForStatus(port, agentId, want) {
  const deadline = Date.now() + 15_000
  for (;;) {
    const status = await runtimeStatus(port, agentId)
    if (status === want) return status
    if (Date.now() >= deadline) throw new Error(`status stuck at ${status}, wanted ${want}`)
    await sleep(50)
  }
}

test('daemon process verdicts drive the roster status with no interpretation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-process-liveness-'))
  const dbPath = join(dir, 'fleet.db')
  const store = new FleetStore(dbPath, { taskDoc: false })
  try {
    store.upsertAgent({ id: 'fleet:live', friendly_name: 'live', dead: false, human: false })
  } finally {
    store.close()
  }
  const port = await unusedPort()
  const child = await startServer({ dir, dbPath, port })
  try {
    const ws = await openDaemon(port)
    try {
      assert.equal(await runtimeStatus(port, 'fleet:live'), 'hibernating')
      ws.send(JSON.stringify({ type: 'process-liveness', agent_id: 'fleet:live', alive: 'yes' }))
      await sleep(300)
      assert.equal(await runtimeStatus(port, 'fleet:live'), 'hibernating')
      ws.send(JSON.stringify({ type: 'process-liveness', agent_id: 'fleet:live', alive: true }))
      assert.equal(await waitForStatus(port, 'fleet:live', 'awake'), 'awake')
      ws.send(JSON.stringify({ type: 'process-liveness', agent_id: 'fleet:live', alive: false }))
      assert.equal(await waitForStatus(port, 'fleet:live', 'hibernating'), 'hibernating')
    } finally {
      ws.close()
    }
  } finally {
    if (child.exitCode == null) {
      child.kill('SIGTERM')
      await new Promise(resolve => child.once('exit', resolve))
    }
    removeTempDir(dir)
  }
})
