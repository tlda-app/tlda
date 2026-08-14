import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import test from 'node:test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliSource = readFileSync(path.join(root, 'cli', 'tlda.mjs'), 'utf8')

function help(noun) {
  return spawnSync(process.execPath, ['cli/tlda.mjs', noun, '--help'], {
    cwd: root,
    encoding: 'utf8',
  })
}

function command(...args) {
  return spawnSync(process.execPath, ['cli/tlda.mjs', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, TLDA_ENV: 'testing' },
  })
}

// The bot half of this file asserted `tlda bot install|start|restart|stop` and the
// refusal each of them printed. Those commands are gone — bot supervision is
// reconciled by config apply and nothing else — and bin/bot-start-dry-run-regression-test.mjs
// asserts their absence, so the two files contradicted each other and this one had
// been failing on main since the commands were deleted.
test('managed service help exposes restart and refusal commands', () => {
  const daemon = help('daemon')
  assert.equal(daemon.status, 0, daemon.stderr)
  assert.match(daemon.stdout, /tlda daemon \[start\|restart\|stop/)
  assert.match(daemon.stdout, /already-loaded launchd service/)
  assert.match(daemon.stdout, /Stop refuses because unloading the job/)

  const server = help('server')
  assert.equal(server.status, 0, server.stderr)
  assert.match(server.stdout, /start\|restart\|stop/)
  assert.match(server.stdout, /Start and stop refuse/)

  const bot = help('bot')
  assert.equal(bot.status, 0, bot.stderr)
  assert.match(bot.stdout, /start\|restart\|stop/)
  assert.match(bot.stdout, /Start and stop refuse/)
})

test('all launchctl destructive verbs are rejected above ignoreFailure', () => {
  const gate = cliSource.match(/async function runLaunchctl[\s\S]*?\n\}/)?.[0] || ''
  assert.match(gate, /verb === 'bootout'.*verb === 'unload'.*verb === 'remove'/s)
  assert.ok(gate.indexOf('Refusing launchctl') < gate.indexOf('try {'))
})

test('server start and doctor do not smuggle managed lifecycle writes', () => {
  const server = cliSource.match(/async function cmdServer[\s\S]*?\n\}\n\nasync function cmdSystem/)?.[0] || ''
  const start = server.match(/if \(sub === 'start'\)[\s\S]*?Unknown subcommand/)?.[0] || ''
  const doctor = cliSource.match(/async function cmdDoctor\(\)[\s\S]*?\n\}\n\nasync function cmdDoctorYolo/)?.[0] || ''
  assert.doesNotMatch(start, /ensureFleetDaemonRunning|execSync\(['"]launchctl (?:bootstrap|kickstart)/)
  assert.doesNotMatch(doctor, /execSync\(['"]launchctl (?:bootstrap|kickstart)/)
  assert.match(doctor, /Server launchd job is not loaded/)
  assert.match(doctor, /KeepAlive launchd job remains loaded/)
  assert.doesNotMatch(server, /for \(;;\)/)
  assert.match(server, /Server did not stop within/)
  assert.match(server, /Last shutdown failure:/)
  assert.match(server, /Server did not become ready within/)
  assert.match(server, /Last readiness failure:/)
  assert.doesNotMatch(cliSource, /execFileSync\(process\.execPath, \[[^\n]*'daemon', 'start'/)
})

test('server restart returns nonzero when KeepAlive never restores readiness', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tlda-server-restart-timeout-'))
  const configDir = path.join(dir, '.config', 'tlda')
  const binDir = path.join(dir, 'bin')
  mkdirSync(path.join(dir, 'Library', 'LaunchAgents'), { recursive: true })
  mkdirSync(configDir, { recursive: true })
  mkdirSync(binDir, { recursive: true })
  writeFileSync(path.join(dir, 'Library', 'LaunchAgents', 'com.tlda.server.plist'), '<plist/>')
  writeFileSync(path.join(configDir, 'daemon.yaml'), 'machineId: test\nenvironments:\n  default: stable\n  values:\n    stable:\n      database: http://127.0.0.1:54321\n      store: http://127.0.0.1:54321\n      licenseKey: ""\nregions: {}\nprofiles: {}\ngrants: {}\nmodels: {}\n')
  writeFileSync(path.join(configDir, 'server.yaml'), '')
  writeFileSync(path.join(binDir, 'launchctl'), '#!/bin/sh\nif [ "$1" = print ]; then echo "state = running"; exit 0; fi\nexit 0\n', { mode: 0o755 })
  try {
    const result = spawnSync(process.execPath, ['cli/tlda.mjs', 'server', 'restart'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, HOME: dir, TLDA_CONFIG_DIR: configDir, TLDA_SERVER_RESTART_TIMEOUT_MS: '200', PATH: `${binDir}:${process.env.PATH}` },
    })
    assert.equal(result.status, 1, result.stderr || result.stdout)
    assert.match(result.stderr, /Server did not become ready within 1s/)
    assert.match(result.stderr, /Last readiness failure:/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('server restart does not mistake a timed-out old health endpoint for stopped', { skip: process.platform !== 'darwin' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tlda-server-stop-timeout-'))
  const configDir = path.join(dir, '.config', 'tlda')
  const binDir = path.join(dir, 'bin')
  const portFile = path.join(dir, 'port')
  const hangingServer = path.join(dir, 'hanging-server.mjs')
  mkdirSync(path.join(dir, 'Library', 'LaunchAgents'), { recursive: true })
  mkdirSync(configDir, { recursive: true })
  mkdirSync(binDir, { recursive: true })
  writeFileSync(path.join(dir, 'Library', 'LaunchAgents', 'com.tlda.server.plist'), '<plist/>')
  writeFileSync(hangingServer, `import http from 'node:http'; import { writeFileSync } from 'node:fs'; const s=http.createServer(() => {}); s.listen(0,'127.0.0.1',()=>writeFileSync(${JSON.stringify(portFile)},String(s.address().port)));`)
  writeFileSync(path.join(binDir, 'launchctl'), '#!/bin/sh\nif [ "$1" = print ]; then echo "state = running"; exit 0; fi\nexit 0\n', { mode: 0o755 })
  const child = spawn(process.execPath, [hangingServer], { stdio: 'ignore' })
  try {
    for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(existsSync(portFile), true, 'hanging fixture did not listen')
    const port = readFileSync(portFile, 'utf8').trim()
    writeFileSync(path.join(configDir, 'daemon.yaml'), `machineId: test\nenvironments:\n  default: stable\n  values:\n    stable:\n      database: http://127.0.0.1:${port}\n      store: http://127.0.0.1:${port}\n      licenseKey: ""\nregions: {}\nprofiles: {}\ngrants: {}\nmodels: {}\n`)
    writeFileSync(path.join(configDir, 'server.yaml'), '')
    const result = spawnSync(process.execPath, ['cli/tlda.mjs', 'server', 'restart'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 8000,
      env: { ...process.env, HOME: dir, TLDA_CONFIG_DIR: configDir, TLDA_SERVER_STOP_TIMEOUT_MS: '200', PATH: `${binDir}:${process.env.PATH}` },
    })
    assert.equal(result.status, 1, result.stderr || result.stdout)
    assert.match(result.stderr, /Server did not stop within 1s/)
    assert.match(result.stderr, /Last shutdown failure:/)
    assert.doesNotMatch(result.stderr, /Server did not become ready/)
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stop refuses before unloading a loaded service', { skip: process.platform !== 'darwin' }, () => {
  const daemon = command('daemon', 'stop')
  assert.equal(daemon.status, 1)
  assert.match(daemon.stderr, /Refusing to unload the supervised fleet daemon/)
})
