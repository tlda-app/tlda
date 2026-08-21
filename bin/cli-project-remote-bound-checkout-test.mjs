#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { daemonLifecycleSocketPath } from '../shared/daemon-socket-path.mjs'

const repo = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'tlda-cli-project-remote-'))
const configDir = join(root, 'config')
const outsideCheckout = join(root, 'outside-checkout')
mkdirSync(configDir, { recursive: true })
mkdirSync(outsideCheckout)
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

let request = null
const socketPath = daemonLifecycleSocketPath(configDir, 'test')
const daemon = createServer({ allowHalfOpen: true }, socket => {
  let raw = ''
  socket.setEncoding('utf8')
  socket.on('data', chunk => { raw += chunk })
  socket.on('end', () => {
    request = JSON.parse(raw)
    socket.end(`${JSON.stringify({ ok: true, result: { remote: 'origin', branch: 'bound-branch', commit: 'abc123' } })}\n`)
  })
})

try {
  await new Promise(resolve => daemon.listen(socketPath, resolve))
  const child = spawn(process.execPath, [join(repo, 'cli/tlda.mjs'), '--env', 'test', 'project', 'remote', 'push', 'origin', '--project', 'paper'], {
    cwd: outsideCheckout,
    env: { ...process.env, TLDA_CONFIG_DIR: configDir, TLDA_DAEMON_CONFIG_DIR: configDir, TLDA_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const status = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`CLI timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 10_000)
    child.on('error', reject)
    child.on('exit', code => { clearTimeout(timer); resolve(code) })
  })

  assert.equal(status, 0, stderr)
  assert.equal(request.op, 'project-git-remote')
  assert.deepEqual(request.params, { project: 'paper', operation: 'push', name: 'origin' })
  assert.match(stdout, /"branch": "bound-branch"/)
} finally {
  await new Promise(resolve => daemon.close(resolve))
  rmSync(root, { recursive: true, force: true })
}
