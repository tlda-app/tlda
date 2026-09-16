#!/usr/bin/env node

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { resolveMainDaemonScript } from '../shared/daemon-identity.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const cliSource = readFileSync(join(root, 'cli', 'tlda.mjs'), 'utf8')
const deploy = cliSource.match(/async function cmdDeploy\(\)[\s\S]*?\n\}\n\n\/\/ ---- setup/)?.[0] || ''
assert.doesNotMatch(deploy, /server (?:start|stop)'[^\n]*timeout/)
assert.match(deploy, /execFileSync\(process\.execPath, \[join\(tldaRoot, 'cli', 'tlda\.mjs'\), 'server', 'restart'\]/)
assert.match(deploy, /fetchForDeploy\('deploy SPA verification'/)
assert.match(deploy, /fetchForDeploy\('deploy projects verification'/)
assert.doesNotMatch(deploy, /projects API unavailable/)

const doctor = cliSource.match(/async function cmdDoctor\(\)[\s\S]*?\n\}\n\nasync function cmdDoctorYolo/)?.[0] || ''
assert.doesNotMatch(doctor, /server (?:start|stop)[^\n]*timeout/)
assert.match(doctor, /fixFailures\+\+/)
assert.match(doctor, /fix(?:es)?[^`]*did not complete/)

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
  const child = spawn(process.execPath, [join(root, 'cli', 'tlda.mjs'), 'daemon', 'restart', '--env', 'stable'], {
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
  assert.match(stdout, /Fleet daemon restarted through launchd/)
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
loaded="$TLDA_CONFIG_DIR/loaded.definition"
if [ "$1" = "print" ]; then test -f "$loaded" && cat "$loaded"; exit $?; fi
if [ "$1" = "bootout" ]; then rm -f "$loaded"; exit 0; fi
if [ "$1" = "bootstrap" ]; then
  {
    echo "arguments = {"
    /usr/libexec/PlistBuddy -c "Print :ProgramArguments:0" "$3"
    /usr/libexec/PlistBuddy -c "Print :ProgramArguments:1" "$3"
    /usr/libexec/PlistBuddy -c "Print :ProgramArguments:2" "$3"
    echo "}"
    printf "working directory = "
    /usr/libexec/PlistBuddy -c "Print :WorkingDirectory" "$3"
    echo "environment = {"
    printf "PATH => "
    /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:PATH" "$3"
    printf "TLDA_ENV => "
    /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:TLDA_ENV" "$3"
    printf "NODE_OPTIONS => "
    /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:NODE_OPTIONS" "$3"
    echo "}"
  } > "$loaded"
  exit 0
fi
if [ "$1" = "kickstart" ]; then test -f "$loaded"; exit $?; fi
exit 0
`, { mode: 0o755 })
const applyPlist = join(applyFixture, 'Library', 'LaunchAgents', 'com.tlda.fleet-daemon.stable.plist')
try {
  const applyCliRoot = process.env.TLDA_CONFIG_APPLY_CLI_ROOT || root
  const runApply = () => spawnSync(process.execPath, [join(applyCliRoot, 'cli', 'tlda.mjs'), 'config', 'apply', '--only', 'stable', '--env', 'stable'], {
    cwd: applyCliRoot,
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
  const initialApply = runApply()
  assert.equal(initialApply.status, 0, initialApply.stderr)
  assert.match(initialApply.stdout, /Added com\.tlda\.fleet-daemon\.stable/)
  const canonicalPlist = readFileSync(applyPlist, 'utf8')
  const daemonScript = join(applyCliRoot, 'bin', 'fleet-daemon.mjs')
  const expectedScript = resolveMainDaemonScript(daemonScript) || daemonScript
  const expectedRoot = dirname(dirname(expectedScript))
  writeFileSync(join(applyConfigDir, 'loaded.definition'), `arguments = {
/bin/zsh
-fc
exec /opt/homebrew/bin/node --import tsx "${expectedScript}"
}
working directory = ${expectedRoot}
environment = {
PATH => ${join(applyFixture, '.local', 'bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
TLDA_ENV => stable
NODE_OPTIONS => --require=/Users/you/worktrees/land-tonight/shared/node-dns-alias.cjs
}
`)
  const startedAt = Date.now()
  const apply = runApply()
  const elapsed = Date.now() - startedAt
  assert.equal(apply.status, 0, apply.stderr)
  assert.ok(elapsed < 2000, `config apply should replace a loaded job without retrying (${elapsed}ms)`)
  assert.match(apply.stdout, /Updated com\.tlda\.fleet-daemon\.stable/)
  assert.doesNotMatch(apply.stdout, /Pending/)
  assert.match(apply.stdout, /tlda config apply complete/)
  const plist = readFileSync(applyPlist, 'utf8')
  assert.equal(plist, canonicalPlist)
  assert.match(plist, new RegExp(expectedScript.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(plist, new RegExp(dirname(dirname(expectedScript)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  const loadedDefinition = readFileSync(join(applyConfigDir, 'loaded.definition'), 'utf8')
  assert.match(loadedDefinition, new RegExp(expectedScript.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(loadedDefinition, new RegExp(dirname(dirname(expectedScript)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(loadedDefinition, new RegExp(join(dirname(dirname(expectedScript)), 'shared', 'node-dns-alias.cjs').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  console.log('cli config completion boundary: ok')
} finally {
  rmSync(applyFixture, { recursive: true, force: true })
}
