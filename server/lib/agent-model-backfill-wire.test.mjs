// The backfill crosses a process boundary: a sender reads the daemon's mint
// store, the server's `agent-model` handler writes agent metadata. Calling both
// halves in one process would prove neither, and an unrecognised message type
// is acknowledged normally here — a severed wire reports health. So this test
// sends over a real socket to a real server and then reads the row back off
// disk, which is the only evidence that the write happened.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'

import { FleetStore } from './fleet-store.mjs'

async function unusedPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

function startServer({ dir, dbPath, port }) {
  return spawn(process.execPath, ['server/unified-server.mjs', '--i-am-tlda-cli'], {
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
}

async function waitForServer(child) {
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const deadline = Date.now() + 90_000
  while (!output.includes('Unified server running')) {
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}: ${output}`)
    if (Date.now() >= deadline) throw new Error(`server did not start: ${output}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return
  child.kill('SIGTERM')
  await new Promise(resolve => child.once('exit', resolve))
}

async function seedAgents(dbPath) {
  const store = new FleetStore(dbPath, { taskDoc: false })
  const now = new Date().toISOString()
  try {
    // Minted with no model — the row the panel expansion has nothing to show for.
    await store.upsertAgent({
      id: 'fleet:model-missing',
      friendly_name: 'model-missing',
      labels: [],
      registered_at: now,
      last_seen: now,
      metadata: { kind: 'claude' },
    })
    // Minted with one. The seat's own record; the backfill must not talk over it.
    await store.upsertAgent({
      id: 'fleet:model-present',
      friendly_name: 'model-present',
      labels: [],
      registered_at: now,
      last_seen: now,
      metadata: { kind: 'claude', model: 'opus' },
    })
  } finally {
    store.close()
  }
}

function sendAgentModel(port, fills) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws/fleet?agent=backfill-test`, { rejectUnauthorized: false })
  const replies = new Map()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply for ${fills.length - replies.size} message(s)`)), 30_000)
    ws.on('error', reject)
    ws.on('open', () => {
      for (const fill of fills) {
        ws.send(JSON.stringify({ type: 'agent-model', id: fill.id, agent_id: fill.agent_id, model: fill.model }))
      }
    })
    ws.on('message', raw => {
      const message = JSON.parse(String(raw))
      if (!fills.some(fill => fill.id === message.id)) return
      replies.set(message.id, message)
      if (replies.size < fills.length) return
      clearTimeout(timer)
      ws.close()
      resolve(replies)
    })
  })
}

function metadataFor(dbPath, id) {
  const store = new FleetStore(dbPath, { taskDoc: false })
  try {
    return store.getAgent(id)?.metadata || null
  } finally {
    store.close()
  }
}

test('agent-model fills a missing model over the wire and leaves an existing one alone', { timeout: 180_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-agent-model-wire-'))
  const dbPath = join(dir, 'fleet.db')
  await seedAgents(dbPath)
  const port = await unusedPort()
  const child = startServer({ dir, dbPath, port })
  try {
    await waitForServer(child)
    const replies = await sendAgentModel(port, [
      { id: 'fill-missing', agent_id: 'fleet:model-missing', model: 'sonnet' },
      { id: 'fill-present', agent_id: 'fleet:model-present', model: 'sonnet' },
    ])

    assert.equal(replies.get('fill-missing').result?.filled, true)
    assert.equal(replies.get('fill-present').result?.filled, false)

    // Read the rows back off disk: the reply is the handler's word for it, the
    // stored metadata is the fact the panel reads.
    const missing = metadataFor(dbPath, 'fleet:model-missing')
    const present = metadataFor(dbPath, 'fleet:model-present')
    assert.equal(missing.model, 'sonnet')
    assert.equal(missing.kind, 'claude', 'the fill must not drop the rest of the metadata')
    assert.equal(present.model, 'opus', 'an existing model is the seat record and must survive')
  } finally {
    await stopServer(child)
    rmSync(dir, { recursive: true, force: true })
  }
})
