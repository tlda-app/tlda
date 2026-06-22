import test from 'node:test'
import assert from 'node:assert/strict'
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

test('daemon bot supervisor starts configured bots for this machine', async () => {
  const dir = tmpDir('bot-start')
  const script = path.join(dir, 'bot.mjs')
  writeFileSync(script, `
    import { writeFileSync } from 'node:fs'
    writeFileSync(process.env.TLDA_BOT_PIDFILE, String(process.pid))
    setInterval(() => {}, 1000)
  `)

  const supervisor = createManagedBotSupervisor({
    bots: [{ name: 'testbot', script, machine_id: 'air' }],
    machineId: 'air',
    resolveScript: s => s,
    configDir: dir,
    log: silentLog(),
  })

  supervisor.ensureAll()
  const pidFile = path.join(dir, 'testbot.pid')
  assert.equal(await waitFor(() => existsSync(pidFile)), true)
  const pid = parseInt(readFileSync(pidFile, 'utf8'), 10)
  assert.ok(pid > 0)

  try { process.kill(pid, 'SIGTERM') } catch (e) { if (e?.code !== 'ESRCH') throw e }
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

test('daemon bot supervisor respawns without requiring server readiness', () => {
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

  supervisor.ensureAll()
  supervisor.ensureAll()

  assert.equal(spawns.length, 2)
  assert.equal(spawns[0].env.TLDA_BOT_NAME, 'serverless')
  assert.equal(spawns[0].env.TLDA_BOT_PIDFILE, path.join(dir, 'serverless.pid'))
  assert.equal(spawns[0].env.TLDA_SERVER, undefined)
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
