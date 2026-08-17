// Two fleet frames carrying the same `operation_id` are the SAME logical
// operation. The MCP client's durable-send outbox retries under that id when its
// wait exceeds FLEET_DURABLE_SEND_DEADLINE_MS, so a slow operation is routinely
// delivered twice — and before the coalescing wrapper in handleFleetWsMessage,
// the second delivery ran the whole handler again.
//
// Measured cost, 2026-08-17: one `delegate()` of a recurring task produced FOUR
// inbox notifications — two `delegate` events with consecutive ids from the two
// runs, then two `timer` events, because each run also wrote a pending reminder
// with the same fire_at and both fired later.
//
// This drives the REAL socket against a REAL server process, because that is the
// boundary the duplicate crosses. Calling the handler twice in-process would
// prove the guard and not the wire.
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

test('a delegate retried under the same operation_id runs once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-operation-coalesce-wire-'))
  const dbPath = join(dir, 'fleet.db')
  const store = new FleetStore(dbPath, { taskDoc: false })
  try {
    await store.upsertAgent({ id: 'fleet:caller', friendly_name: 'coalesce-caller', dead: false })
    await store.upsertAgent({ id: 'fleet:worker', friendly_name: 'coalesce-worker', dead: false })
  } finally {
    store.close()
  }

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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  try {
    await waitForServer(child)
    const ws = new WebSocket(`wss://127.0.0.1:${port}/ws/fleet`, { rejectUnauthorized: false })
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })

    const replies = new Map()
    const bothReplied = new Promise(resolve => {
      ws.on('message', raw => {
        const message = JSON.parse(String(raw))
        if (message.id !== 1 && message.id !== 2) return
        replies.set(message.id, message)
        if (replies.size === 2) resolve()
      })
    })

    // Same operation_id, distinct request ids — exactly what the client's outbox
    // sends when its own wait timed out. Both go out before the first can
    // finish, which is the race; a sequential pair would be caught by the
    // pre-existing completed-result check and would prove nothing.
    const frame = id => JSON.stringify({
      id,
      type: 'delegate',
      operation_id: 'op-coalesce-test',
      agent: 'fleet:worker',
      from: 'fleet:caller',
      description: 'Recurring coordination checkpoint',
      message: 'do the thing',
      notify_every: 900,
    })
    ws.send(frame(1))
    ws.send(frame(2))

    await Promise.race([
      bothReplied,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`only ${replies.size} of 2 frames answered`)), 30_000)),
    ])
    ws.close()

    // Both frames must be answered. A coalesce that leaves the retry hanging
    // would "fix" the duplicate by stranding the caller, which is worse: the
    // client would retry again.
    assert.equal(replies.size, 2, 'both frames answered')

    const after = new FleetStore(dbPath, { taskDoc: false })
    try {
      const delegates = after.db.prepare("SELECT COUNT(*) c FROM events WHERE type = 'delegate'").get().c
      const tasks = after.db.prepare('SELECT COUNT(*) c FROM tasks').get().c
      const timers = after.db.prepare("SELECT COUNT(*) c FROM events WHERE type = 'timer'").get().c

      // The bug produced 2 delegate events and 2 timer events for one call.
      assert.equal(delegates, 1, `exactly one delegate event (got ${delegates})`)
      assert.equal(tasks, 1, `exactly one task row (got ${tasks})`)
      assert.equal(timers, 1, `exactly one pending timer (got ${timers})`)
    } finally {
      after.close()
    }
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
    rmSync(dir, { recursive: true, force: true })
  }
})
