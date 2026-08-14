#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const fixture = mkdtempSync(join(tmpdir(), 'tlda-cli-service-completion-'))
const configDir = join(fixture, '.config', 'tlda')
const binDir = join(fixture, 'fake-bin')
const fakeDaemonDir = join(fixture, 'bin')
mkdirSync(configDir, { recursive: true })
mkdirSync(binDir, { recursive: true })
mkdirSync(fakeDaemonDir, { recursive: true })
mkdirSync(join(fixture, 'Library', 'LaunchAgents'), { recursive: true })

const sockets = new Set()
const target = net.createServer(socket => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
})
await new Promise((resolve, reject) => {
  target.once('error', reject)
  target.listen(0, '127.0.0.1', resolve)
})
const port = target.address().port
const serverUrl = `http://localhost:${port}`

writeFileSync(join(configDir, 'daemon.yaml'), `machineId: mini
statusScanSeconds: 2
environments:
  default: stable
  values:
    stable:
      database: ${serverUrl}
      store: ${serverUrl}
      licenseKey: ""
regions: {}
profiles: {}
grants: {}
models: {}
`)
writeFileSync(join(configDir, 'server.yaml'), '')

const singletonModule = join(root, 'agent-runtime', 'singleton-lock.mjs')
const fakeDaemon = join(fakeDaemonDir, 'fleet-daemon.mjs')
writeFileSync(fakeDaemon, `
import net from 'node:net'
import { writeFileSync, appendFileSync } from 'node:fs'
import { daemonSingletonLockPath, acquireSingletonLock } from ${JSON.stringify(singletonModule)}
const configDir = process.env.TLDA_CONFIG_DIR
const pidFile = configDir + '/fleet-daemon.stable.pid'
const logFile = configDir + '/fleet-daemon.stable.log'
const server = process.env.PROOF_SERVER
const lockPath = daemonSingletonLockPath({ configDir, origin: 'mini:stable' })
const held = acquireSingletonLock({ lockPath, installPath: process.argv[1], origin: 'mini:stable' })
if (!held.ok) process.exit(2)
writeFileSync(pidFile, String(process.pid))
appendFileSync(logFile, '[daemon] fleet-daemon starting pid=' + process.pid + '\\n')
const socket = net.connect(Number(process.env.PROOF_PORT), '127.0.0.1')
setTimeout(() => {
  appendFileSync(logFile, '[daemon] daemon-ready pid=' + process.pid + ' server=' + server + ' machine_id=mini env_name=stable watchers=started\\n')
}, 1200)
process.on('SIGTERM', () => { socket.destroy(); process.exit(0) })
setInterval(() => {}, 1000)
`)

const launchctl = join(binDir, 'launchctl')
writeFileSync(launchctl, `#!/bin/sh
pidfile="$TLDA_CONFIG_DIR/fleet-daemon.stable.pid"
if [ "$1" = "print" ]; then
  echo "state = running"
  if [ -f "$pidfile" ]; then echo "pid = $(cat "$pidfile")"; fi
  exit 0
fi
if [ "$1" = "kickstart" ]; then
  ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeDaemon)} >/dev/null 2>&1 &
  exit 0
fi
exit 0
`, { mode: 0o755 })

let daemonPid = null
try {
  const startedAt = Date.now()
  const child = spawn(process.execPath, [join(root, 'cli', 'tlda.mjs'), 'daemon', 'start', '--env', 'stable'], {
    cwd: root,
    env: {
      ...process.env,
      HOME: fixture,
      TLDA_CONFIG_DIR: configDir,
      TLDA_CONFIG: undefined,
      TLDA_SERVER: undefined,
      TLDA_SYNC_SERVER: undefined,
      PROOF_SERVER: serverUrl,
      PROOF_PORT: String(port),
      PATH: `${binDir}:${process.env.PATH}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`daemon start did not finish\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 15_000)
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
  const elapsed = Date.now() - startedAt
  assert.deepEqual(result, { code: 0, signal: null }, stderr)
  assert.ok(elapsed >= 1100, `daemon start returned before ready marker (${elapsed}ms)`)
  assert.match(stdout, /Fleet daemon launchd job started/)
  assert.doesNotMatch(stdout, /readiness pending/)
  daemonPid = Number(readFileSync(join(configDir, 'fleet-daemon.stable.pid'), 'utf8'))
  assert.ok(Number.isFinite(daemonPid) && daemonPid > 0)
  console.log('cli service completion boundary: ok')
} finally {
  if (!daemonPid) {
    try { daemonPid = Number(readFileSync(join(configDir, 'fleet-daemon.stable.pid'), 'utf8')) } catch {
      // Startup may have failed before the fixture daemon wrote its pidfile.
    }
  }
  if (daemonPid) {
    try { process.kill(daemonPid, 'SIGTERM') } catch {
      // The fixture daemon may already have exited during a failed assertion.
    }
  }
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => target.close(resolve))
  rmSync(fixture, { recursive: true, force: true })
}

const applyFixture = mkdtempSync(join(tmpdir(), 'tlda-cli-config-completion-'))
const applyConfigDir = join(applyFixture, '.config', 'tlda')
const applyBinDir = join(applyFixture, 'fake-bin')
mkdirSync(applyConfigDir, { recursive: true })
mkdirSync(applyBinDir, { recursive: true })
mkdirSync(join(applyFixture, 'Library', 'LaunchAgents'), { recursive: true })
writeFileSync(join(applyConfigDir, 'daemon.yaml'), `machineId: mini
statusScanSeconds: 2
environments:
  default: stable
  values:
    stable:
      database: https://stable.example
      store: https://stable.example
      licenseKey: ""
regions: {}
profiles: {}
grants: {}
models: {}
`)
writeFileSync(join(applyConfigDir, 'server.yaml'), '')
writeFileSync(join(applyBinDir, 'launchctl'), `#!/bin/sh
if [ "$1" = "managername" ]; then echo Aqua; exit 0; fi
if [ "$1" = "bootstrap" ]; then
  case "$3" in
    *capcheck*) exit 0 ;;
    *)
      counter="$TLDA_CONFIG_DIR/config-apply-attempts"
      n=0
      if [ -f "$counter" ]; then n=$(cat "$counter"); fi
      n=$((n + 1))
      echo "$n" > "$counter"
      if [ "$n" -eq 1 ]; then echo "transient bootstrap refusal" >&2; exit 7; fi
      exit 0
      ;;
  esac
fi
exit 0
`, { mode: 0o755 })
try {
  const startedAt = Date.now()
  const apply = spawnSync(process.execPath, [join(root, 'cli', 'tlda.mjs'), 'config', 'apply', '--env', 'stable'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      HOME: applyFixture,
      TLDA_CONFIG_DIR: applyConfigDir,
      TLDA_CONFIG: undefined,
      TLDA_SERVER: undefined,
      TLDA_SYNC_SERVER: undefined,
      PATH: `${applyBinDir}:${process.env.PATH}`,
    },
  })
  const elapsed = Date.now() - startedAt
  assert.equal(apply.status, 0, apply.stderr)
  assert.ok(elapsed >= 450, `config apply returned before retry delay (${elapsed}ms)`)
  assert.match(apply.stderr, /attempt 1 did not complete/)
  assert.match(apply.stderr, /unfinished job\(s\); retrying/)
  assert.match(apply.stdout, /Added com\.tlda\.fleet-daemon\.stable/)
  assert.match(apply.stdout, /tlda config apply complete/)
  assert.equal(readFileSync(join(applyConfigDir, 'config-apply-attempts'), 'utf8').trim(), '2')
  console.log('cli config completion boundary: ok')
} finally {
  rmSync(applyFixture, { recursive: true, force: true })
}
