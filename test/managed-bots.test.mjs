import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8')
}

test('daemon no longer supervises managed bots', () => {
  const daemonSource = read('bin/fleet-daemon.mjs')

  assert.equal(daemonSource.includes('getManagedBots'), false)
  assert.equal(daemonSource.includes('createManagedBotSupervisor'), false)
  assert.equal(daemonSource.includes('bot-supervisor'), false)
  assert.equal(daemonSource.includes('TLDA_BOT_PIDFILE'), false)
})

test('managed bot supervisor helper was removed', () => {
  assert.equal(existsSync(path.join(ROOT, 'bin', 'lib', 'managed-bots.mjs')), false)
})

test('cli owns explicit bot launchd management', () => {
  const cliSource = read('cli/tlda.mjs')

  assert.equal(cliSource.includes('case \'bot\': await cmdBot(); break'), true)
  assert.equal(cliSource.includes('getManagedBots'), true)
  assert.equal(cliSource.includes('function cmdBot()'), true)
  assert.equal(cliSource.includes('TLDA_BOT_PIDFILE'), true)
  assert.equal(cliSource.includes('TLDA_BOT_IDFILE'), true)
  assert.equal(cliSource.includes('TLDA_BOT_MACHINE_ID'), true)
  assert.equal(cliSource.includes('TLDA_BOT_TMUX_SESSION'), true)
  assert.equal(cliSource.includes('tmux new-session -d -s'), true)
  assert.equal(cliSource.includes('tmux wait-for'), true)
})

test('bot install dry-run prints standalone launchd service plan', () => {
  const res = spawnSync(process.execPath, [path.join(ROOT, 'cli', 'tlda.mjs'), 'bot', 'install', 'todd', '--dry-run'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, TLDA_CONFIG: process.env.TLDA_CONFIG || 'default' },
  })

  assert.equal(res.status, 0, res.stderr || res.stdout)
  assert.match(res.stdout, /Would install bot service:/)
  assert.match(res.stdout, /todd: com\.tlda\.bot\.todd/)
  assert.match(res.stdout, /Script: .*bin\/todd\.mjs/)
  assert.match(res.stdout, /Tmux: fleet-bot-todd/)
  assert.match(res.stdout, /Plist: .*com\.tlda\.bot\.todd\.plist/)
})

test('Todd behavior identity model survives', () => {
  const toddSource = read('bin/todd.mjs')
  const serverSource = read('server/unified-server.mjs')

  assert.match(toddSource, /const AGENT_ID = loadOrCreateFleetId\(\)/)
  assert.match(toddSource, /TLDA_BOT_IDFILE/)
  assert.match(toddSource, /TLDA_BOT_TMUX_SESSION/)
  assert.match(toddSource, /function isCanonicalBot\(\)/)
  assert.match(serverSource, /retiring legacy bot row/)
})
