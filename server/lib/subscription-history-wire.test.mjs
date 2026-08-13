// The subscribe-filter wire, end to end.
//
// The block-scoped history query crosses four seams: the socket handler, the
// queryPage lambda that chooses the block query, the off-loop store proxy that
// must expose the method, and the SQL itself. Calling history() with a stub
// queryPage proves the first end; calling queryChatHistoryBlocks() directly
// proves the last. Neither says anything about whether they are connected, and
// AGENTS.md §"Prove the wire, not the two ends" exists because that gap has
// shipped here three times.
//
// This is the class the project says a test is for: a failure that would be
// both silent and destructive. A severed seam here returns an empty history
// page, which reads to the user as "there is nothing older" rather than as an
// error — the scrollback simply stops.

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

/** Subscribe a filter over the real socket and collect the history page. */
async function historyOverWebSocket(port, filter, { window = 10, before = null } = {}) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws/fleet`, { rejectUnauthorized: false })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  try {
    const events = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no filter-events within 20s')), 20_000)
      // The envelope is `{ event, data }`, not `{ type, ... }`. Matching the
      // wrong shape here returns an empty page forever, which is exactly the
      // severed-wire symptom this test exists to detect — an instrument that
      // cannot see the thing reports its absence just as confidently.
      ws.on('message', raw => {
        let msg
        try { msg = JSON.parse(raw.toString()) } catch { return }
        if (msg.event === 'filter-events' && msg.data?.subId === 'sub-wire') {
          clearTimeout(timer)
          resolve(msg.data.events || [])
        }
      })
      ws.send(JSON.stringify({
        type: 'subscribe-filter', subId: 'sub-wire', filter, window, before,
      }))
    })
    return events
  } finally {
    ws.close()
  }
}

test('subscribe-filter returns history through the block-scoped query', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-history-wire-'))
  const dbPath = join(dir, 'fleet.db')

  const store = new FleetStore(dbPath, { taskDoc: false })
  for (let i = 0; i < 6; i++) {
    await store.insertEventRecord({
      type: 'chat',
      from: i % 2 === 0 ? 'fleet:aaa' : 'fleet:bbb',
      to: i % 2 === 0 ? 'fleet:bbb' : 'fleet:aaa',
      text: `wire-m${i}`,
      timestamp: `2026-08-0${i + 1}T00:00:00.000Z`,
    }, { notify: false })
  }
  store.close?.()

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
    const events = await historyOverWebSocket(port, [[['from', 'fleet:aaa']]])

    // The seam being proven: rows come back at all. An empty page here is what a
    // severed wire looks like, and it is indistinguishable from "no history" at
    // the panel.
    assert.ok(events.length > 0, 'subscribe-filter returned an empty history page')

    // Recipients survive the block query's own exit. Raw rows would leave every
    // `to:` term matching nothing, which is silent loss rather than an error.
    for (const event of events) {
      assert.ok(Array.isArray(event.recipients), `event ${event.text} has no recipients array`)
    }

    const texts = events.map(e => e.text)
    assert.ok(texts.every(t => t.startsWith('wire-m')), `unexpected rows: ${texts.join()}`)
  } finally {
    child.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})
