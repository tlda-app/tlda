#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MintStore } from '../daemon/mint-store.mjs'
import { daemonLifecycleSocketPath } from '../shared/daemon-socket-path.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-cli-lifecycle-completion-'))
const configDir = join(root, 'config')
mkdirSync(configDir, { recursive: true })
writeFileSync(join(configDir, 'server.yaml'), '')
writeFileSync(join(configDir, 'daemon.yaml'), `machineId: test
environments:
  default: test
  values:
    test:
      database: http://127.0.0.1:9
      store: http://127.0.0.1:9
      licenseKey: ""
`)

const partialId = 'mint:resume-across-cli-boundary'
const store = new MintStore(join(configDir, 'daemon-mints.sqlite'), { defaultEnvName: 'test' })
store.ensure(partialId)
store.setFact(partialId, 'env_name', 'test')
store.setFact(partialId, 'friendly_name', 'resume-proof')
store.setFact(partialId, 'launch_recipe', { cwd: root, kind: 'codex' })
store.setFact(partialId, 'process_state', { tmux_session: 'fleet-resume-proof', session_id: 'session:resume-proof' })
store.setFact(partialId, 'session_id', 'session:resume-proof')
store.close()

let request = null
const socketPath = daemonLifecycleSocketPath(configDir, 'test')
const daemon = createServer({ allowHalfOpen: true }, socket => {
  let raw = ''
  socket.setEncoding('utf8')
  socket.on('data', chunk => { raw += chunk })
  socket.on('end', async () => {
    request = JSON.parse(raw)
    socket.write(`${JSON.stringify({ event: 'server-registration-attempt', data: { local_agent_id: partialId, attempt: 1 } })}\n`)
    socket.write(`${JSON.stringify({ event: 'server-registration-deferred', data: { local_agent_id: partialId, reason: 'test outage', retry_in_ms: 10 } })}\n`)
    await new Promise(resolve => setTimeout(resolve, 25))
    socket.end(`${JSON.stringify({ ok: true, result: { ok: true, mint_id: partialId, fleet_id: 'fleet:resume-proof', joined: true, tmux_session: 'fleet-resume-proof' } })}\n`)
  })
})

try {
  await new Promise(resolve => daemon.listen(socketPath, resolve))
  const child = spawn(process.execPath, [join(process.cwd(), 'cli/tlda.mjs'), '--env', 'test', 'agent', 'mint', 'resume-proof', '--cwd', root], {
    cwd: root,
    env: {
      ...process.env,
      TLDA_CONFIG_DIR: configDir,
      TLDA_DAEMON_CONFIG_DIR: configDir,
      TLDA_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const status = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`CLI timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 5_000)
    child.on('error', reject)
    child.on('exit', code => { clearTimeout(timer); resolve(code) })
  })
  assert.equal(status, 0, stderr)
  assert.equal(request.op, 'mint')
  assert.equal(request.params.mint_id, partialId, 'the CLI must resume the durable partial mint instead of allocating another')
  assert.match(stdout, new RegExp(`Resuming partial mint ${partialId}`))
  assert.match(stdout, /Server registration attempt 1/)
  assert.match(stdout, /test outage; retrying in 1s/)
  assert.match(stdout, /Created fleet-resume-proof \(fleet:resume-proof\)/)
} finally {
  await new Promise(resolve => daemon.close(resolve))
  rmSync(root, { recursive: true, force: true })
}

console.log('cli lifecycle completion boundary: ok')
