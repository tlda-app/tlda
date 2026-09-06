import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { get } from 'node:https'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FleetStore } from './fleet-store.mjs'
import { removeTempDir } from './test-support/remove-temp-dir.mjs'

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

function requestJson(port, path) {
  return new Promise((resolve, reject) => {
    const request = get({ hostname: '127.0.0.1', port, path, rejectUnauthorized: false }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`${response.statusCode} ${path}: ${body}`))
          return
        }
        try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
      })
    })
    request.on('error', reject)
  })
}

async function assertSelectable(port) {
  const roster = await requestJson(port, '/api/fleet-table?filter=fleet%3Atlda')
  assert.equal(roster.matched, 1)
  assert.deepEqual(roster.agents.map(agent => agent.id), ['fleet:tlda'])

  const lookup = await requestJson(port, '/api/agents/lookup?ids=fleet%3Atlda')
  assert.equal(lookup.agents.length, 1)
  assert.equal(lookup.agents[0].id, 'fleet:tlda')
  assert.equal(lookup.agents[0].friendly_name, 'tlda')
  assert.equal(lookup.agents[0].dead, false)
  assert.equal(lookup.agents[0].human, false)
  assert.deepEqual(lookup.agents[0].labels, [])
}

test('startup registers one stable selectable fleet:tlda identity', { timeout: 240_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-server-identity-'))
  const dbPath = join(dir, 'fleet.db')
  let child
  try {
    const firstPort = await unusedPort()
    child = startServer({ dir, dbPath, port: firstPort })
    await waitForServer(child)
    await assertSelectable(firstPort)
    await stopServer(child)
    child = null

    const firstStore = new FleetStore(dbPath, { taskDoc: false })
    const registeredAt = firstStore.getAgent('fleet:tlda').registered_at
    const firstNames = firstStore.db.prepare(
      'SELECT friendly_name, from_ts, to_ts FROM name_history WHERE fleet_id = ? ORDER BY id'
    ).all('fleet:tlda')
    await firstStore.close()

    const secondPort = await unusedPort()
    child = startServer({ dir, dbPath, port: secondPort })
    await waitForServer(child)
    await assertSelectable(secondPort)
    await stopServer(child)
    child = null

    const secondStore = new FleetStore(dbPath, { taskDoc: false })
    try {
      const rows = secondStore.db.prepare('SELECT * FROM agents WHERE id = ?').all('fleet:tlda')
      assert.equal(rows.length, 1)
      assert.equal(rows[0].registered_at, registeredAt)
      assert.equal(rows[0].dead, 0)
      assert.equal(rows[0].human, 0)
      assert.deepEqual(
        secondStore.db.prepare(
          'SELECT friendly_name, from_ts, to_ts FROM name_history WHERE fleet_id = ? ORDER BY id'
        ).all('fleet:tlda'),
        firstNames,
      )
    } finally {
      await secondStore.close()
    }
  } finally {
    await stopServer(child)
    removeTempDir(dir)
  }
})
