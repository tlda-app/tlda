import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { botRuntimePaths, createBotSupervisor } from './bot-supervisor.mjs'

function supervisorFixture({ bots, configDir = mkdtempSync(join(tmpdir(), 'tlda-bot-supervisor-')), responses = [] } = {}) {
  const calls = []
  const run = async (cmd, args) => {
    calls.push([cmd, args])
    const next = responses.shift()
    if (next instanceof Error) throw next
    return next || { stdout: '', stderr: '' }
  }
  const supervisor = createBotSupervisor({
    config: { bots },
    configDir,
    rootDir: '/repo',
    machineId: 'mini',
    pathEnv: '/bin:/usr/bin',
    tldaConfig: 'default',
    tldaServer: 'https://fleet.example.test',
    tldaSyncServer: 'https://sync.example.test',
    tlsCaPath: '/tmp/rootCA.pem',
    execFileP: run,
    log: { info() {}, error() {} },
  })
  return { calls, configDir, supervisor }
}

test('daemon bot supervisor starts configured local bot in tmux with bot environment', async () => {
  const { calls, supervisor } = supervisorFixture({
    bots: [
      { name: 'todd', script: 'bin/bots/todd.mjs' },
      { name: 'remote', script: '/tmp/remote.mjs', machine_id: 'other-machine' },
    ],
    responses: [
      new Error('missing session'),
      { stdout: '', stderr: '' },
    ],
  })

  const results = await supervisor.ensureAll('test-start')

  assert.deepEqual(results.map(([name]) => name), ['todd'])
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], ['tmux', ['has-session', '-t', 'fleet-bot-todd']])
  assert.equal(calls[1][0], 'tmux')
  assert.deepEqual(calls[1][1].slice(0, 4), ['new-session', '-d', '-s', 'fleet-bot-todd'])
  const command = calls[1][1][4]
  assert.match(command, /TLDA_BOT_NAME='todd'/)
  assert.match(command, /TLDA_BOT_MACHINE_ID='mini'/)
  assert.match(command, /TLDA_BOT_TMUX_SESSION='fleet-bot-todd'/)
  assert.match(command, /TLDA_CONFIG='default'/)
  assert.match(command, /TLDA_SERVER='https:\/\/fleet\.example\.test'/)
  assert.match(command, /TLDA_SYNC_SERVER='https:\/\/sync\.example\.test'/)
  assert.match(command, /NODE_EXTRA_CA_CERTS='\/tmp\/rootCA\.pem'/)
  assert.match(command, /'\/repo\/bin\/bots\/todd\.mjs'/)
})

test('daemon bot supervisor does not restart healthy bot session', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'tlda-bot-supervisor-'))
  const paths = botRuntimePaths('todd', { configDir })
  mkdirSync(configDir, { recursive: true })
  writeFileSync(paths.pidFile, String(process.pid))
  writeFileSync(paths.heartbeatFile, `${new Date().toISOString()} heartbeat\n`)
  const { calls, supervisor } = supervisorFixture({
    configDir,
    bots: [{ name: 'todd', script: 'bin/bots/todd.mjs' }],
    responses: [{ stdout: '', stderr: '' }],
  })

  const results = await supervisor.ensureAll('healthy-check')

  assert.equal(results[0][1].started, false)
  assert.equal(results[0][1].reason, 'healthy')
  assert.deepEqual(calls, [['tmux', ['has-session', '-t', 'fleet-bot-todd']]])
})

test('daemon bot supervisor treats pid-only bot as healthy when heartbeat file is absent', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'tlda-bot-supervisor-'))
  const paths = botRuntimePaths('teacher', { configDir })
  mkdirSync(configDir, { recursive: true })
  writeFileSync(paths.pidFile, String(process.pid))
  const { calls, supervisor } = supervisorFixture({
    configDir,
    bots: [{ name: 'teacher', script: '/repo/teacher-bot.mjs' }],
    responses: [{ stdout: '', stderr: '' }],
  })

  const results = await supervisor.ensureAll('pid-only-check')

  assert.equal(results[0][1].started, false)
  assert.equal(results[0][1].reason, 'healthy')
  assert.equal(results[0][1].health.hasHeartbeat, false)
  assert.deepEqual(calls, [['tmux', ['has-session', '-t', 'fleet-bot-teacher']]])
})

test('daemon bot supervisor replaces stale existing tmux bot session', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'tlda-bot-supervisor-'))
  const paths = botRuntimePaths('todd', { configDir })
  mkdirSync(configDir, { recursive: true })
  writeFileSync(paths.pidFile, '99999999')
  writeFileSync(paths.heartbeatFile, `${new Date(Date.now() - 10 * 60_000).toISOString()} heartbeat\n`)
  const { calls, supervisor } = supervisorFixture({
    configDir,
    bots: [{ name: 'todd', script: 'bin/bots/todd.mjs' }],
    responses: [
      { stdout: '', stderr: '' },
      { stdout: '', stderr: '' },
      { stdout: '', stderr: '' },
    ],
  })

  const results = await supervisor.ensureAll('stale-heartbeat')

  assert.equal(results[0][1].started, true)
  assert.deepEqual(calls[0], ['tmux', ['has-session', '-t', 'fleet-bot-todd']])
  assert.deepEqual(calls[1], ['tmux', ['kill-session', '-t', 'fleet-bot-todd']])
  assert.deepEqual(calls[2][1].slice(0, 4), ['new-session', '-d', '-s', 'fleet-bot-todd'])
})
