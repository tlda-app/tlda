#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { daemonLifecycleSocketPath } from '../shared/daemon-socket-path.mjs'
import { MintStore } from '../daemon/mint-store.mjs'

const repo = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'tlda-real-cli-proof-'))
const home = join(root, 'home')
const config = join(home, '.config', 'tlda')
const launchAgents = join(home, 'Library', 'LaunchAgents')
const fakeBin = join(root, 'bin')
mkdirSync(config, { recursive: true })
mkdirSync(launchAgents, { recursive: true })
mkdirSync(fakeBin, { recursive: true })
const serverState = join(root, 'server-state')
const npmMode = join(root, 'npm-mode')
writeFileSync(serverState, 'up')
writeFileSync(npmMode, 'ok')

let spaAttempts = 0
let projectAttempts = 0
let reanimateAttempts = 0
let prefValue = null
let markedDead = false
const http = createServer((req, res) => {
  if (readFileSync(serverState, 'utf8').trim() === 'down') return req.socket.destroy()
  req.resume()
  req.on('end', () => {
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type })
      res.end(type === 'application/json' ? JSON.stringify(body) : body)
    }
    if (req.url === '/health') return send(200, { pid: 999999 })
    if (req.method === 'GET' && req.url === '/') {
      spaAttempts++
      if (spaAttempts === 1) return send(503, 'retry', 'text/plain')
      return send(200, '<html><div id="root"></div></html>', 'text/html')
    }
    if (req.method === 'GET' && req.url === '/api/projects') {
      projectAttempts++
      if (projectAttempts === 1) return send(503, { error: 'projects transient' })
      return send(200, { projects: [] })
    }
    if (req.method === 'POST' && req.url === '/api/agents/proof/reanimate') {
      reanimateAttempts++
      return reanimateAttempts === 1 ? send(503, { error: 'reanimate transient' }) : send(200, { agent: 'proof' })
    }
    if (req.method === 'GET' && req.url === '/api/state') return send(200, { agents: [{ id: 'fleet:proof', friendly_name: 'proof', dead: markedDead }] })
    if (req.method === 'POST' && req.url === '/api/agents/fleet%3Aproof/mark-dead') { markedDead = true; return send(200, { ok: true }) }
    if (req.method === 'POST' && req.url === '/api/fleet/prefs/spawn_machine_id') { prefValue = 'mini'; return send(200, { ok: true }) }
    if (req.method === 'GET' && req.url.startsWith('/api/fleet/prefs/spawn_machine_id')) return send(200, { value: prefValue })
    if (req.method === 'POST' && req.url === '/api/set-metadata') return send(200, { ok: true })
    return send(404, { error: `unexpected ${req.method} ${req.url}` })
  })
})

const run = (args, extra = {}, timeout = 20_000) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(repo, 'cli/tlda.mjs'), ...args], {
    cwd: repo,
    env: { ...process.env, HOME: home, TLDA_CONFIG_DIR: config, TLDA_DAEMON_CONFIG_DIR: config, TLDA_SERVER: serverUrl, TLDA_ENV: 'stable', PATH: `${fakeBin}:${process.env.PATH}`, FLEET_ID: undefined, FLEET_HARNESS: undefined, FLEET_TMUX_SESSION: undefined, FLEET_NAME: undefined, TMUX: undefined, TMUX_PANE: undefined, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', c => { stdout += c })
  child.stderr.on('data', c => { stderr += c })
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out: ${args.join(' ')}\n${stdout}\n${stderr}`)) }, timeout)
  child.on('error', reject)
  child.on('exit', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }) })
})

let serverUrl
let createdDist = false
try {
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  serverUrl = `http://127.0.0.1:${http.address().port}`
  writeFileSync(join(config, 'server.yaml'), '')
  writeFileSync(join(config, 'daemon.yaml'), `machineId: ${hostname().split('.')[0]}\nenvironments:\n  default: stable\n  values:\n    stable:\n      database: ${serverUrl}\n      store: ${serverUrl}\n      licenseKey: ""\nprofiles:\n  proof:\n    allow:\n      - Read\n`)
  writeFileSync(join(launchAgents, 'com.tlda.server.plist'), '<plist/>')
  writeFileSync(join(config, 'fleet-daemon.stable.pid'), String(process.pid))
  writeFileSync(join(fakeBin, 'launchctl'), `#!/bin/sh
case "$*" in
  *bootout*) echo down > ${JSON.stringify(serverState)} ;;
  *bootstrap*|*kickstart*) echo up > ${JSON.stringify(serverState)} ;;
esac
exit 0
`, { mode: 0o755 })
  writeFileSync(join(fakeBin, 'npm'), `#!/bin/sh
if [ "$(cat ${JSON.stringify(npmMode)})" = fail ]; then echo injected-build-failure >&2; exit 9; fi
exit 0
`, { mode: 0o755 })

  let out = await run(['agent', 'reanimate', 'proof'])
  assert.equal(out.status, 0, out.stdout + out.stderr)
  assert.equal(reanimateAttempts, 2)
  assert.match(out.stderr, /attempt 1 did not complete.*retrying/)
  assert.match(out.stdout, /Reanimated proof/)

  out = await run(['agent', 'set-mint-machine', 'fleet:proof', 'mini'])
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /Set spawn_machine_id.*mini/)

  out = await run(['agent', 'dismiss', 'proof'])
  assert.equal(out.status, 0, out.stderr)
  assert.equal(markedDead, true)
  assert.match(out.stdout, /Dismissed proof/)

  out = await run(['agent', 'permissions', 'proof', 'proof', '--on-wake'])
  assert.equal(out.status, 1)
  assert.doesNotMatch(out.stdout, /Updated .* permissions/)

  out = await run(['agent', 'move', 'missing', 'stable'])
  assert.equal(out.status, 1)
  assert.match(out.stderr, /No agent named/)

  out = await run(['project', 'book', 'proof-book', '--members', 'missing'])
  assert.equal(out.status, 1)
  assert.match(out.stderr, /Member "missing" not found/)
  const scratchFile = join(root, 'proof.md')
  writeFileSync(scratchFile, '# proof\n')
  out = await run(['project', 'scratch', scratchFile])
  assert.equal(out.status, 1)
  out = await run(['project', 'unlink', 'proof', 'https://example.com/proof.git'])
  assert.equal(out.status, 1)
  out = await run(['project', 'delete', 'already-absent'])
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /already absent/)
  out = await run(['project', 'move', 'proof', 'stable', '--dry-run'])
  assert.equal(out.status, 1)

  const socketPath = daemonLifecycleSocketPath(config, 'stable')
  const mintStore = new MintStore(join(config, 'daemon-mints.sqlite'), { defaultEnvName: 'stable' })
  mintStore.ensure('mint:wake-proof')
  mintStore.setFact('mint:wake-proof', 'fleet_id', 'fleet:proof')
  mintStore.setFact('mint:wake-proof', 'friendly_name', 'proof')
  mintStore.setFact('mint:wake-proof', 'env_name', 'stable')
  mintStore.setFact('mint:wake-proof', 'process_state', { tmux_session: 'fleet-proof' })
  mintStore.close()
  const daemon = createNetServer({ allowHalfOpen: true }, socket => {
    let raw = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => { raw += chunk })
    socket.on('end', () => {
      const request = JSON.parse(raw)
      socket.write(`${JSON.stringify({ event: 'wake-attempt', data: { fleet_id: 'fleet:proof', attempt: 1 } })}\n`)
      socket.end(`${JSON.stringify({ ok: true, result: { ok: true, fleet_id: 'fleet:proof', op: request.op } })}\n`)
    })
  })
  await new Promise(resolve => daemon.listen(socketPath, resolve))
  const wake = spawn(process.execPath, [join(repo, 'cli/tlda.mjs'), 'agent', 'wake', 'fleet:proof'], { cwd: repo, env: { ...process.env, HOME: home, TLDA_CONFIG_DIR: config, TLDA_DAEMON_CONFIG_DIR: config, TLDA_SERVER: serverUrl, TLDA_ENV: 'stable' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let wakeOut = '', wakeErr = ''
  wake.stdout.on('data', c => { wakeOut += c }); wake.stderr.on('data', c => { wakeErr += c })
  const wakeCode = await new Promise(resolve => wake.on('exit', resolve))
  assert.equal(wakeCode, 0, wakeErr)
  assert.match(wakeOut, /Wake attempt 1/)
  await new Promise(resolve => daemon.close(resolve))

  let restartAttempts = 0
  const restartDaemon = createNetServer({ allowHalfOpen: true }, socket => {
    socket.resume()
    socket.on('end', () => {
      restartAttempts++
      socket.end(`${JSON.stringify(restartAttempts === 1
        ? { ok: true, result: { ok: false, error: 'restart transient' } }
        : { ok: true, result: { ok: true } })}\n`)
    })
  })
  await new Promise(resolve => restartDaemon.listen(socketPath, resolve))
  out = await run(['restart-mcp', 'proof'], { TLDA_DEV_CLI: '1' })
  assert.equal(out.status, 0, out.stderr)
  assert.equal(restartAttempts, 2)
  assert.match(out.stdout, /unfinished: restart transient[\s\S]*ok/)
  assert.match(out.stderr, /retrying in/)
  await new Promise(resolve => restartDaemon.close(resolve))

  spaAttempts = 0; projectAttempts = 0
  mkdirSync(join(repo, 'dist'), { recursive: true })
  writeFileSync(join(repo, 'dist', 'index.html'), `<html><body><div id="root"></div>${'x'.repeat(200)}</body></html>`)
  createdDist = true
  out = await run(['deploy'], { TLDA_DEV_CLI: '1' }, 30_000)
  assert.equal(out.status, 0, out.stdout + out.stderr)
  assert.equal(spaAttempts, 2)
  assert.equal(projectAttempts, 2)
  assert.match(out.stderr, /deploy SPA verification attempt 1 did not complete/)
  assert.match(out.stderr, /deploy projects verification attempt 1 did not complete/)

  writeFileSync(join(launchAgents, 'com.tlda.server.plist'), '<plist/>')
  writeFileSync(join(fakeBin, 'launchctl'), '#!/bin/sh\necho injected-uninstall-refusal >&2\nexit 7\n', { mode: 0o755 })
  out = await run(['server', 'uninstall'])
  assert.equal(out.status, 1)
  assert.doesNotMatch(out.stdout, /Uninstalled launchd service/)

  rmSync(join(repo, 'dist'), { recursive: true, force: true })
  createdDist = false
  writeFileSync(npmMode, 'fail')
  writeFileSync(join(fakeBin, 'launchctl'), `#!/bin/sh
case "$*" in
  *bootout*) echo down > ${JSON.stringify(serverState)} ;;
  *bootstrap*|*kickstart*) echo up > ${JSON.stringify(serverState)} ;;
esac
exit 0
`, { mode: 0o755 })
  out = await run(['doctor', '--fix'], {}, 30_000)
  assert.equal(out.status, 1)
  assert.match(out.stdout + out.stderr, /fix(?:es)? did not complete/)

  console.log(JSON.stringify({ reanimate: { command: 'tlda agent reanimate proof', attempts: reanimateAttempts, exit: 0 }, setMintMachine: { command: 'tlda agent set-mint-machine fleet:proof mini', readback: prefValue, exit: 0 }, dismiss: { command: 'tlda agent dismiss proof', markedDead, exit: 0 }, permissions: { command: 'tlda agent permissions proof proof --on-wake', induced: 'server row dead', exit: 1 }, move: { command: 'tlda agent move missing stable', induced: 'missing durable ledger identity', exit: 1 }, wake: { command: 'tlda agent wake fleet:proof', visible: 'Wake attempt 1', exit: 0 }, restartMcp: { command: 'tlda-dev restart-mcp proof', attempts: restartAttempts, exit: 0 }, book: { command: 'tlda project book proof-book --members missing', induced: 'missing member', exit: 1 }, scratch: { command: `tlda project scratch ${scratchFile}`, induced: 'create endpoint failure', exit: 1 }, unlink: { command: 'tlda project unlink proof https://example.com/proof.git', induced: 'unlink endpoint failure', exit: 1 }, delete: { command: 'tlda project delete already-absent', induced: '404 readback', exit: 0 }, projectMove: { command: 'tlda project move proof stable --dry-run', induced: 'missing project', exit: 1 }, deploy: { command: 'tlda-dev deploy', induced: 'SPA and projects verification return 503 once', attemptsPerVerification: 2, exit: 0 }, uninstall: { command: 'tlda server uninstall', induced: 'launchctl exit 7', exit: 1 }, doctorFix: { command: 'tlda doctor --fix', induced: 'npm repair exit 9', exit: 1 } }, null, 2))
} finally {
  await new Promise(resolve => http.close(resolve))
  if (createdDist) rmSync(join(repo, 'dist'), { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
}
