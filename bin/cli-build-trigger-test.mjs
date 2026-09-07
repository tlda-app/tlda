#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { daemonLifecycleSocketPath } from '../shared/daemon-socket-path.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-cli-build-trigger-'))
const configDir = join(root, 'config')
mkdirSync(configDir, { recursive: true })
writeFileSync(join(configDir, 'server.yaml'), '')
writeFileSync(join(configDir, 'daemon.yaml'), `machineId: test\nenvironments:\n  default: test\n  values:\n    test:\n      database: http://127.0.0.1:9\n      store: http://127.0.0.1:9\n`)
const socketPath = daemonLifecycleSocketPath(configDir, 'test')
let request = null
const server = createServer({ allowHalfOpen: true }, socket => {
  let raw = ''
  socket.setEncoding('utf8')
  socket.on('data', chunk => { raw += chunk })
  socket.on('end', () => {
    request = JSON.parse(raw)
    socket.end(`${JSON.stringify({ ok: true, result: { revision: '1234567890abcdef' } })}\n`)
  })
})

try {
  await new Promise(resolve => server.listen(socketPath, resolve))
  const child = spawn(process.execPath, [join(process.cwd(), 'cli/tlda.mjs'), '--env', 'test', 'build', 'disposable'], {
    env: { ...process.env, TLDA_CONFIG_DIR: configDir, TLDA_DAEMON_CONFIG_DIR: configDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const status = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CLI timed out\n${stdout}\n${stderr}`)), 10_000)
    child.on('error', reject)
    child.on('close', code => { clearTimeout(timer); resolve(code) })
  })

  assert.equal(status, 0, stderr)
  assert.deepEqual(request, { op: 'project-rebuild', params: { project: 'disposable' } })
  assert.match(stdout, /Submitted 1234567 through the daemon Git remote/)
  assert.match(stdout, /Build triggered for "disposable"/)
  assert.doesNotMatch(stdout, /collaborative LaTeX paper review/)
} finally {
  await new Promise(resolve => server.close(resolve))
  rmSync(root, { recursive: true, force: true })
}

console.log('cli build trigger: ok')
