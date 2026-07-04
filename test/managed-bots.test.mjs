import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createManagedBotSupervisor,
  filterBotsForMachine,
} from '../bin/lib/managed-bots.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP_ROOT = path.join(ROOT, '.tmp-tests')

function tmpDir(name) {
  const dir = path.join(TMP_ROOT, `${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

async function waitFor(fn, timeoutMs = 3000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true
    await new Promise(r => setTimeout(r, 25))
  }
  return false
}

function silentLog() {
  return { info() {}, warn() {}, error() {} }
}

test('daemon bot supervisor starts configured bots for this machine in tmux', async () => {
  const dir = tmpDir('bot-start')
  const script = path.join(dir, 'bot.mjs')
  writeFileSync(script, '')
  const spawns = []

  const supervisor = createManagedBotSupervisor({
    bots: [{ name: 'testbot', script, machine_id: 'air' }],
    machineId: 'air',
    resolveScript: s => s,
    configDir: dir,
    log: silentLog(),
    env: {},
    spawnImpl: (cmd, args, opts) => {
      spawns.push({ cmd, args, env: opts.env })
      return { unref() {} }
    },
    timers: {
      setTimeout(fn) { fn(); return { unref() {} } },
      setInterval() { return { unref() {} } },
    },
  })

  await supervisor.ensureAll()
  assert.equal(spawns.length, 1)
  assert.equal(spawns[0].cmd, 'tmux')
  assert.deepEqual(spawns[0].args.slice(0, 4), ['new-session', '-d', '-s', spawns[0].env.TLDA_BOT_TMUX_SESSION])
  assert.match(spawns[0].env.TLDA_BOT_TMUX_SESSION, /^fleet-bot-testbot-/)
  assert.equal(spawns[0].env.TLDA_BOT_NAME, 'testbot')
  assert.equal(spawns[0].env.TLDA_BOT_PIDFILE, path.join(dir, 'testbot.pid'))
  assert.equal(spawns[0].env.TLDA_BOT_IDFILE, path.join(dir, 'testbot.fleet-id'))
  assert.equal(spawns[0].env.TLDA_BOT_MACHINE_ID, 'air')
  rmSync(dir, { recursive: true, force: true })
})

test('managed bots are filtered by machine_id before spawning', () => {
  const bots = [
    { name: 'owned', script: '/tmp/owned.mjs', machine_id: 'air' },
    { name: 'foreign', script: '/tmp/foreign.mjs', machine_id: 'mini' },
    { name: 'single-machine-default', script: '/tmp/default.mjs' },
  ]

  assert.deepEqual(
    filterBotsForMachine(bots, 'air', silentLog()).map(b => b.name),
    ['owned', 'single-machine-default']
  )
})

test('daemon bot supervisor respawns without requiring server readiness', async () => {
  const dir = tmpDir('bot-respawn')
  const script = path.join(dir, 'bot.mjs')
  writeFileSync(script, '')
  const spawns = []
  const supervisor = createManagedBotSupervisor({
    bots: [{ name: 'serverless', script }],
    machineId: 'air',
    resolveScript: s => s,
    configDir: dir,
    env: {},
    log: silentLog(),
    spawnImpl: (cmd, args, opts) => {
      spawns.push({ cmd, args, env: opts.env })
      return { unref() {} }
    },
    timers: {
      setTimeout(fn) { fn(); return { unref() {} } },
      setInterval() { return { unref() {} } },
    },
    now: () => Date.now(),
  })

  await supervisor.ensureAll()
  await supervisor.ensureAll()

  assert.equal(spawns.length, 2)
  assert.equal(spawns[0].env.TLDA_BOT_NAME, 'serverless')
  assert.equal(spawns[0].env.TLDA_BOT_PIDFILE, path.join(dir, 'serverless.pid'))
  assert.equal(spawns[0].cmd, 'tmux')
  assert.equal(spawns[0].env.TLDA_SERVER, undefined)
  rmSync(dir, { recursive: true, force: true })
})

test('daemon bot supervisor recycles live todd when heartbeat is stale', async () => {
  const dir = tmpDir('bot-stale-heartbeat')
  const script = path.join(dir, 'bot.mjs')
  writeFileSync(script, '')
  const pidFile = path.join(dir, 'todd.pid')
  const heartbeatFile = path.join(dir, 'todd.heartbeat')
  writeFileSync(pidFile, '424242')
  writeFileSync(heartbeatFile, '{"ts":"old"}\n')

  const killed = []
  const origKill = process.kill
  process.kill = (pid, sig) => {
    if (pid === 424242 && (sig === 0 || sig === undefined)) return true
    killed.push({ pid, sig })
    return true
  }

  const spawns = []
  try {
    const supervisor = createManagedBotSupervisor({
      bots: [{ name: 'todd', script, heartbeatTimeoutMs: 1000 }],
      machineId: 'air',
      resolveScript: s => s,
      configDir: dir,
      env: {},
      log: silentLog(),
      spawnImpl: (cmd, args, opts) => {
        spawns.push({ cmd, args, env: opts.env })
        return { unref() {} }
      },
      timers: {
        setTimeout(fn) { fn(); return { unref() {} } },
        setInterval() { return { unref() {} } },
      },
      now: () => Date.now() + 10_000,
    })

    await supervisor.ensureAll()
  } finally {
    process.kill = origKill
  }

  assert.deepEqual(killed, [{ pid: 424242, sig: 'SIGTERM' }])
  assert.equal(spawns.length, 1)
  assert.equal(spawns[0].env.TLDA_BOT_HEARTBEAT, heartbeatFile)
  rmSync(dir, { recursive: true, force: true })
})

test('daemon bot supervisor does not spawn when canonical bot name is already held', async () => {
  const dir = tmpDir('bot-name-held')
  const script = path.join(dir, 'bot.mjs')
  writeFileSync(script, '')
  const httpServer = createServer((req, res) => {
    if (req.url === '/api/store/agents') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ agents: [{ id: 'fleet:other', friendly_name: 'todd', dead: false, hibernating: true }] }))
      return
    }
    res.writeHead(404); res.end()
  })
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve))
  const port = httpServer.address().port
  const spawns = []
  try {
    const supervisor = createManagedBotSupervisor({
      bots: [{ name: 'todd', script }],
      machineId: 'air',
      resolveScript: s => s,
      configDir: dir,
      fleetServerUrl: `http://127.0.0.1:${port}`,
      env: {},
      log: silentLog(),
      spawnImpl: () => {
        spawns.push(true)
        return { unref() {} }
      },
      timers: {
        setTimeout(fn) { fn(); return { unref() {} } },
        setInterval() { return { unref() {} } },
      },
    })
    await supervisor.ensureAll()
  } finally {
    await new Promise(resolve => httpServer.close(resolve))
  }
  assert.equal(spawns.length, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('server no longer owns managed bot pidfiles', () => {
  const serverSource = readFileSync(path.join(ROOT, 'server', 'unified-server.mjs'), 'utf8')
  assert.equal(serverSource.includes('getManagedBots'), false)
  assert.equal(serverSource.includes('bot-supervisor'), false)
  assert.equal(serverSource.includes('TLDA_BOT_PIDFILE'), false)
})

test('cli no longer starts managed bots after server start', () => {
  const cliSource = readFileSync(path.join(ROOT, 'cli', 'tlda.mjs'), 'utf8')
  assert.equal(cliSource.includes('getManagedBots'), false)
  assert.equal(cliSource.includes('ensureManagedBotsRunning'), false)
  assert.equal(cliSource.includes('TLDA_BOT_PIDFILE'), false)
})
