import assert from 'node:assert/strict'
import https from 'node:https'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FleetStore } from '../server/lib/fleet-store.mjs'

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

function postJson(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = https.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      rejectUnauthorized: false,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => {
        let json = null
        if (text) {
          try {
            json = JSON.parse(text)
          } catch (error) {
            reject(error)
            return
          }
        }
        resolve({ status: res.statusCode, text, json })
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
}

function startServer({ dir, dbPath, port }) {
  return spawn(process.execPath, ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: join(import.meta.dirname, '..'),
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

test('education card chat fails without a live teacher sender', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-education-card-missing-teacher-'))
  const dbPath = join(dir, 'fleet.db')
  const store = new FleetStore(dbPath, { taskDoc: false })
  const now = new Date().toISOString()
  await store.upsertAgent({ id: 'fleet:student', friendly_name: 'student', labels: [], registered_at: now, last_seen: now })
  store.close()

  const port = await unusedPort()
  const child = startServer({ dir, dbPath, port })
  try {
    await waitForServer(child)
    const res = await postJson(port, '/api/education/card/fleet%3Astudent', {
      drill: 'sender-owner',
      chat: 'card body',
    })
    assert.equal(res.status, 404)
    assert.equal(res.json?.error, 'Teacher agent not found')
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
  }

  const check = new FleetStore(dbPath, { taskDoc: false })
  assert.deepEqual(check.getDrillCards('fleet:student'), [])
  assert.deepEqual(
    check.db.prepare("SELECT id FROM events WHERE type = 'chat' AND json_extract(metadata, '$.kind') = 'drill-card'").all(),
    [],
  )
  check.close()
  rmSync(dir, { recursive: true, force: true })
})

test('education card chat is sent from the live teacher agent id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-education-card-teacher-'))
  const dbPath = join(dir, 'fleet.db')
  const store = new FleetStore(dbPath, { taskDoc: false })
  const now = new Date().toISOString()
  await store.upsertAgent({ id: 'fleet:teacher-real', friendly_name: 'teacher', labels: [], registered_at: now, last_seen: now })
  await store.upsertAgent({ id: 'fleet:student', friendly_name: 'student', labels: [], registered_at: now, last_seen: now })
  store.close()

  const port = await unusedPort()
  const child = startServer({ dir, dbPath, port })
  try {
    await waitForServer(child)
    const res = await postJson(port, '/api/education/card/fleet%3Astudent', {
      drill: 'sender-owner',
      gradient: 'green',
      pass: true,
      chat: 'card body',
    })
    assert.equal(res.status, 200)
    assert.equal(res.json?.ok, true)
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
  }

  const check = new FleetStore(dbPath, { taskDoc: false })
  const cards = check.getDrillCards('fleet:student')
  assert.equal(cards.length, 1)
  assert.equal(cards[0].drill, 'sender-owner')
  const events = check.db.prepare("SELECT id, type, from_id, text, metadata FROM events WHERE type = 'chat' AND json_extract(metadata, '$.kind') = 'drill-card' ORDER BY id").all()
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'chat')
  assert.equal(events[0].from_id, 'fleet:teacher-real')
  assert.deepEqual(
    check.db.prepare('SELECT agent_id FROM recipients WHERE event_id = ? ORDER BY agent_id').all(events[0].id).map(row => row.agent_id),
    ['fleet:student'],
  )
  assert.equal(JSON.parse(events[0].metadata).kind, 'drill-card')
  check.close()
  rmSync(dir, { recursive: true, force: true })
})
