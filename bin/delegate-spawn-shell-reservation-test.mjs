import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer } from 'ws'

import { spawn } from '../agent-launch/index.mjs'
import { wsReserveShell } from '../agent-launch/register.mjs'

const TEST_MODEL_CONFIG = {
  modelSpecs: {
    goose: {
      alias: 'goose-test',
      id: 'test-goose-model',
      harness: 'goose',
      provider: 'openrouter',
      verified: true,
    },
  },
  modelCatalog: { default: 'goose-test' },
}

function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'delegate-spawn-shell-reservation-'))
}

function makeLedger() {
  const byLocal = new Map()
  const byServer = new Map()
  const deleted = []
  return {
    deleted,
    get(id) {
      return byLocal.get(id) || byServer.get(id) || null
    },
    create(row) {
      const rec = {
        localAgentId: row.localAgentId,
        serverAgentId: row.serverAgentId || null,
        friendlyName: row.friendlyName || null,
      }
      byLocal.set(rec.localAgentId, rec)
      if (rec.serverAgentId) byServer.set(rec.serverAgentId, rec)
      return rec
    },
    bind(localAgentId, serverAgentId, { friendlyName = null } = {}) {
      const rec = byLocal.get(localAgentId)
      if (!rec) return null
      rec.serverAgentId = serverAgentId
      if (friendlyName) rec.friendlyName = friendlyName
      byServer.set(serverAgentId, rec)
      return rec
    },
    delete(id) {
      deleted.push(id)
      const rec = byLocal.get(id) || byServer.get(id)
      if (!rec) return false
      byLocal.delete(rec.localAgentId)
      if (rec.serverAgentId) byServer.delete(rec.serverAgentId)
      return true
    },
  }
}

function makeLibrarian(events) {
  return {
    observeLiveness(event) {
      events.push(['observeLiveness', event])
    },
    failPending(id, reason) {
      events.push(['failPending', id, reason])
    },
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function withWsServer(handler, fn) {
  const wss = new WebSocketServer({ port: 0 })
  await new Promise((resolve, reject) => {
    wss.once('listening', resolve)
    wss.once('error', reject)
  })
  wss.on('connection', ws => {
    ws.on('message', raw => handler(ws, JSON.parse(raw.toString())))
  })
  const { port } = wss.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise(resolve => wss.close(resolve))
  }
}

async function assertRejectsWith(promise, pattern) {
  try {
    await promise
  } catch (e) {
    assert.match(e.message, pattern)
    return e
  }
  fail(`expected rejection matching ${pattern}`)
}

async function testReservationAckTiming() {
  await withWsServer((ws, msg) => {
    setTimeout(() => {
      ws.send(JSON.stringify({ id: msg.id, result: { ok: true, server_agent_id: msg.agent_id } }))
    }, 75)
  }, async api => {
    const result = await wsReserveShell({
      api,
      timeoutMs: 500,
      fleetId: 'fleet:delayed-ack',
      localAgentId: 'local-delayed',
      name: 'delayed-ack',
      tmuxSession: 'fleet-delayed-ack',
      cwd: process.cwd(),
      model: 'test-goose-model',
      kind: 'goose',
    })
    assert.equal(result.server_agent_id, 'fleet:delayed-ack')
  })
  console.log('PASS: delayed reserve-shell ack succeeds with caller timeout')

  await withWsServer(() => {}, async api => {
    await assertRejectsWith(wsReserveShell({
      api,
      timeoutMs: 30,
      fleetId: 'fleet:lost-ack',
      localAgentId: 'local-lost',
      name: 'lost-ack',
      tmuxSession: 'fleet-lost-ack',
      cwd: process.cwd(),
      model: 'test-goose-model',
      kind: 'goose',
    }), /timed out waiting for shell reservation ack/)
  })
  console.log('PASS: lost reserve-shell ack fails deterministically')

  await withWsServer((ws, msg) => {
    const reply = JSON.stringify({ id: msg.id, result: { ok: true, server_agent_id: msg.agent_id } })
    ws.send(reply)
    setTimeout(() => {
      try { ws.send(reply) } catch (e) { // expected duplicate-after-close race
        if (process.env.TLDA_TEST_DEBUG) console.error(`duplicate ack send after client close failed: ${e.message}`)
      }
    }, 10)
  }, async api => {
    const result = await wsReserveShell({
      api,
      timeoutMs: 500,
      fleetId: 'fleet:duplicate-ack',
      localAgentId: 'local-duplicate',
      name: 'duplicate-ack',
      tmuxSession: 'fleet-duplicate-ack',
      cwd: process.cwd(),
      model: 'test-goose-model',
      kind: 'goose',
    })
    assert.equal(result.server_agent_id, 'fleet:duplicate-ack')
  })
  console.log('PASS: duplicate reserve-shell ack resolves once')
}

async function spawnWithDeps(overrides = {}) {
  const cwd = tempDir()
  const ledger = makeLedger()
  const librarianEvents = []
  let tmuxLaunches = 0
  try {
    const result = await spawn({
      spawnMode: 'fresh',
      agentId: 'fleet:delegate-shell-test',
      localAgentId: 'local-delegate-shell-test',
      name: 'delegate-shell-test',
      model: 'goose-test',
      config: TEST_MODEL_CONFIG,
      cwd,
      permissionGrant: 'ops',
      acknowledgeNoSecurity: true,
      localAgentLedger: ledger,
      shellReservationTimeoutMs: 12_345,
      _deps: {
        resolveApi: () => 'http://reservation.test',
        ensureServer: async () => true,
        uniqueSessionName: async () => 'fleet-delegate-shell-test',
        resolveDnsAlias: async () => null,
        checkFreshNameAvailable: async () => true,
        createLibrarian: () => makeLibrarian(librarianEvents),
        wsReserveShell: async () => ({ ok: true, server_agent_id: 'fleet:delegate-shell-test' }),
        spawnTmux: async () => {
          tmuxLaunches += 1
          return true
        },
        ...overrides,
      },
    })
    return { result, ledger, librarianEvents, tmuxLaunches }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

async function testLauncherReservationGate() {
  let attemptedTmux = false
  const serverDownError = await assertRejectsWith(spawnWithDeps({
    ensureServer: async () => false,
    spawnTmux: async () => {
      attemptedTmux = true
      return true
    },
  }), /server shell reservation required/)
  assert.equal(serverDownError.reason, 'launch-failed')
  assert.equal(attemptedTmux, false)
  console.log('PASS: preallocated delegate spawn refuses server-down launch before tmux')

  let lostAckTmux = false
  const lostAckError = await assertRejectsWith(spawnWithDeps({
    wsReserveShell: async ({ timeoutMs }) => {
      assert.equal(timeoutMs, 12_345)
      throw new Error('reserve-shell timed out waiting for shell reservation ack from ws://reservation.test/ws/fleet')
    },
    spawnTmux: async () => {
      lostAckTmux = true
      return true
    },
  }), /reserve-shell timed out/)
  assert.equal(lostAckError.reason, 'launch-failed')
  assert.equal(lostAckTmux, false)
  console.log('PASS: lost reservation ack fails before tmux and prompt delivery')

  const holdReservation = deferred()
  let delayedAckTmux = false
  const launchPromise = spawnWithDeps({
    wsReserveShell: async () => holdReservation.promise,
    spawnTmux: async () => {
      delayedAckTmux = true
      return true
    },
  })
  await Promise.resolve()
  assert.equal(delayedAckTmux, false)
  holdReservation.resolve({ ok: true, server_agent_id: 'fleet:delegate-shell-test' })
  const delayed = await launchPromise
  assert.equal(delayedAckTmux, true)
  assert.equal(delayed.result.fleetId, 'fleet:delegate-shell-test')
  console.log('PASS: delayed reservation ack gates launch until the shell exists')
}

await testReservationAckTiming()
await testLauncherReservationGate()
console.log('ALL CHECKS PASSED')
