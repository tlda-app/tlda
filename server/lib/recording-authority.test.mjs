import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import https from 'node:https'
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

async function openFleetWs(port) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws/fleet`, { rejectUnauthorized: false })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  return ws
}

function wsRequest(ws, id, type, payload = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage)
      reject(new Error(`timed out waiting for fleet ${type} response`))
    }, 10_000)
    const onMessage = raw => {
      const message = JSON.parse(String(raw))
      if (message.id !== id) return
      clearTimeout(timer)
      ws.off('message', onMessage)
      if (message.error) reject(new Error(message.error.message || message.error))
      else resolve(message.result)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ id, type, ...payload }))
  })
}

function httpRequest(port, method, path, { token = null, json = undefined, body = null, contentType = null } = {}) {
  const payload = json === undefined ? body : Buffer.from(JSON.stringify(json))
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: '127.0.0.1', port, method, path, rejectUnauthorized: false,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(contentType ? { 'Content-Type': contentType } : {}),
        ...(payload ? { 'Content-Length': payload.length } : {}),
      },
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed = text
        try { parsed = JSON.parse(text) } catch { /* Non-JSON error bodies remain text for assertions. */ }
        resolve({ status: res.statusCode, body: parsed })
      })
    })
    req.setTimeout(10_000, () => req.destroy(new Error(`${method} ${path} timed out`)))
    req.once('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

test('lecture proposal crosses authenticated fleet wire; only RW HTTP can edit and publish', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-recording-authority-wire-'))
  const configDir = join(dir, 'config')
  const projectsDir = join(dir, 'projects')
  const dbPath = join(dir, 'fleet.db')
  const audioPath = join(dir, 'lecture.webm')
  const ffmpegPath = join(dir, 'ffmpeg-fixture.mjs')
  const agentId = 'fleet:lecture-proposer'
  const rwToken = 'wire-rw-token'
  const readToken = 'wire-read-token'
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'server.yaml'), 'tokenGating: true\ntokensFromEnvironmentOnly: true\n')
  writeFileSync(join(configDir, 'daemon.yaml'), [
    'machineId: wire',
    'environments:',
    '  default: testing',
    '  values:',
    '    testing:',
    '      database: https://127.0.0.1',
    '      store: https://127.0.0.1',
    '      licenseKey: ""',
    '',
  ].join('\n'))

  const store = new FleetStore(dbPath, { taskDoc: false })
  const now = new Date().toISOString()
  await store.upsertAgent({
    id: agentId,
    friendly_name: 'lecture-proposer',
    labels: [],
    registered_at: now,
    last_seen: now,
    dead: false,
    human: false,
    metadata: { shell: true },
  })
  store.close()

  writeFileSync(audioPath, Buffer.from('wire-proof-audio'))
  writeFileSync(ffmpegPath, [
    '#!/usr/bin/env node',
    "import { copyFileSync } from 'node:fs'",
    'const args = process.argv.slice(2)',
    "copyFileSync(args[args.indexOf('-i') + 1], args.at(-1))",
    '',
  ].join('\n'))
  chmodSync(ffmpegPath, 0o755)

  const port = await unusedPort()
  const child = spawn(process.execPath, ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: join(import.meta.dirname, '..', '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      PROJECTS_DIR: projectsDir,
      TLDA_FLEET_DB: dbPath,
      TLDA_CONFIG_DIR: configDir,
      TLDA_DAEMON_CONFIG_DIR: configDir,
      TLDA_ENV: 'testing',
      TLDA_TOKEN_RW: rwToken,
      TLDA_TOKEN_READ: readToken,
      FFMPEG: ffmpegPath,
      TLDA_DEV_SERVER: '1',
      TLDA_TASK_DOC_STARTUP_FLUSH_DELAY_MS: '-1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let authenticated
  let unauthenticated
  try {
    await waitForServer(child)
    assert.equal((await httpRequest(port, 'POST', '/api/projects', {
      token: rwToken,
      json: { name: 'wire-class', title: 'Wire class', format: 'svg' },
    })).status, 201)
    assert.equal((await httpRequest(port, 'POST', '/api/projects/wire-class/recording', {
      token: rwToken,
      json: { id: 'lecture-1', title: 'Lecture 1', created: now, duration_ms: 2_000, audioMime: 'audio/webm', events: [] },
    })).status, 200)
    assert.equal((await httpRequest(port, 'POST', '/api/projects/wire-class/recording/lecture-1/audio', {
      token: rwToken,
      body: readFileSync(audioPath),
      contentType: 'audio/webm',
    })).status, 200)

    unauthenticated = await openFleetWs(port)
    await assert.rejects(wsRequest(unauthenticated, 'unauth', 'lecture-recording-proposal', {
      project: 'wire-class', recording_id: 'lecture-1', start_ms: 100, end_ms: 1_900,
    }), /authenticated fleet-agent connection/)

    authenticated = await openFleetWs(port)
    const login = await wsRequest(authenticated, 'login', 'login', {
      agent_id: agentId,
      machine_id: 'wire',
      env_name: 'testing',
      metadata: { kind: 'codex' },
    })
    assert.equal(login.agent.id, agentId)

    const operationId = `${agentId}:lecture-recording-proposal:wire-proof`
    const proposed = await wsRequest(authenticated, 'proposal', 'lecture-recording-proposal', {
      operation_id: operationId,
      fleet_operation: {
        operation_id: operationId,
        operation_type: 'lecture-recording-proposal',
        delivery_class: 'durable',
        sender: 'fleet:spoofed-envelope',
        destination: null,
        created_at: now,
        attempt: 1,
        parent_operation_id: null,
      },
      project: 'wire-class',
      recording_id: 'lecture-1',
      start_ms: 200,
      end_ms: 1_800,
      actor: 'fleet:spoofed-payload',
      proposedBy: 'fleet:spoofed-payload',
      publish: true,
    })
    assert.equal(proposed.proposedBy, agentId)
    assert.equal(proposed.state, 'candidate-clip')

    const replayedAck = await wsRequest(authenticated, 'proposal-retry', 'lecture-recording-proposal', {
      operation_id: operationId,
      fleet_operation: {
        operation_id: operationId,
        operation_type: 'lecture-recording-proposal',
        delivery_class: 'durable',
        sender: agentId,
        destination: null,
        created_at: now,
        attempt: 2,
        parent_operation_id: null,
      },
      project: 'wire-class', recording_id: 'lecture-1', start_ms: 0, end_ms: 2_000,
    })
    assert.equal(replayedAck.startMs, 200)
    assert.equal(replayedAck.endMs, 1_800)

    const publicationPath = join(projectsDir, 'wire-class', 'recordings', 'publication', 'lecture-1.json')
    const persistedCandidate = JSON.parse(readFileSync(publicationPath, 'utf8'))
    assert.equal(persistedCandidate.proposedBy, agentId)
    assert.equal(persistedCandidate.state, 'candidate-clip')
    assert.equal(persistedCandidate.committedBy, undefined)

    assert.equal((await httpRequest(port, 'PUT', '/api/projects/wire-class/recording/lecture-1/candidate-clip', {
      token: rwToken, json: { startMs: 0, endMs: 2_000 },
    })).status, 404)
    assert.equal((await httpRequest(port, 'PUT', '/api/projects/wire-class/recording/lecture-1/owner-interval', {
      token: readToken, json: { startMs: 300, endMs: 1_700 },
    })).status, 403)
    assert.equal((await httpRequest(port, 'PUT', '/api/projects/wire-class/recording/lecture-1/owner-interval', {
      token: rwToken, json: { startMs: 300, endMs: 1_700 },
    })).status, 200)
    assert.equal((await httpRequest(port, 'POST', '/api/projects/wire-class/recording/lecture-1/publish', {
      token: readToken,
    })).status, 403)
    const published = await httpRequest(port, 'POST', '/api/projects/wire-class/recording/lecture-1/publish', {
      token: rwToken,
    })
    assert.equal(published.status, 200)
    assert.equal(published.body.state, 'published')
    assert.equal(published.body.startMs, 300)
    assert.equal(published.body.endMs, 1_700)
    assert.equal(published.body.proposedBy, agentId)
    assert.equal(published.body.ownerEditedBy, 'classroom:rw')
    assert.equal(published.body.committedBy, 'classroom:rw')
  } finally {
    authenticated?.close()
    unauthenticated?.close()
    child.kill('SIGKILL')
    await new Promise(resolve => child.once('exit', resolve))
    rmSync(dir, { recursive: true, force: true })
  }
})
