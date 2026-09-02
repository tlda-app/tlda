import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'

import { FleetStore } from './fleet-store.mjs'
import { removeTempDir } from './test-support/remove-temp-dir.mjs'

const NOW = '2026-09-02T05:00:00.000Z'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function unusedPort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function waitForServer(child) {
  let output = ''
  child.stdout.on('data', c => { output += c })
  child.stderr.on('data', c => { output += c })
  const deadline = Date.now() + 90_000
  while (!output.includes('Unified server running')) {
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}: ${output}`)
    if (Date.now() >= deadline) throw new Error(`server did not start: ${output}`)
    await sleep(25)
  }
}

async function openFleetWs(port) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws/fleet`, { rejectUnauthorized: false })
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  return ws
}

function request(ws, id, type, payload) {
  return new Promise((resolve, reject) => {
    const onMessage = raw => {
      const message = JSON.parse(String(raw))
      if (message.id !== id) return
      ws.off('message', onMessage)
      if (message.error) reject(new Error(message.error)); else resolve(message.result)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, type, ...payload }))
  })
}

test('server chat routing does not call the full roster for label recipients', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-chat-roster-wire-'))
  const dbPath = join(dir, 'fleet.db')
  const store = new FleetStore(dbPath, { taskDoc: false })
  try {
    await store.upsertAgent({ id: 'fleet:sender', friendly_name: 'sender', labels: [], registered_at: NOW, last_seen: NOW })
    for (let i = 0; i < 1200; i++) {
      await store.upsertAgent({
        id: `fleet:agent-${i}`,
        friendly_name: `agent-${i}`,
        labels: i === 777 ? ['room', 'target-777'] : ['room'],
        registered_at: NOW,
        last_seen: NOW,
      })
    }
    await store.close()

    const port = await unusedPort()
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
        TLDA_TEST_THROW_ON_FULL_ROSTER: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let ws
    try {
      await waitForServer(child)
      ws = await openFleetWs(port)
      const result = await request(ws, 1, 'chat', {
        from: 'fleet:sender',
        to: 'room & target-777',
        message: 'full roster tripwire must stay quiet',
        _tempId: 'full-roster-wire',
      })
      assert.deepEqual(result.recipients, ['fleet:agent-777'])
    } finally {
      ws?.close()
      child.kill('SIGTERM')
      await new Promise(resolve => child.once('exit', resolve))
    }
  } finally {
    removeTempDir(dir)
  }
})
