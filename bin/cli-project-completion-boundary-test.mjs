#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { daemonLifecycleSocketPath } from '../shared/daemon-socket-path.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-cli-project-completion-'))
const configDir = join(root, 'config')
const sourceDir = join(root, 'source')
mkdirSync(configDir, { recursive: true })
mkdirSync(sourceDir, { recursive: true })
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
writeFileSync(join(sourceDir, 'main.tex'), '\\documentclass{article}\\begin{document}test\\end{document}\n')

let fileSnapshots = 0
const http = createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && req.url === '/api/projects/retry-project') return send(200, { name: 'retry-project', mainFile: 'main.tex', format: 'svg' })
    if (req.url?.includes('/source-room/files')) fileSnapshots++
    if (req.method === 'POST' && req.url === '/api/projects') return send(409, { error: 'already exists' })
    if (req.method === 'GET' && req.url === '/api/projects/linked-project') return send(200, { name: 'linked-project', mainFile: 'main.md', format: 'markdown' })
    if (req.method === 'GET' && req.url === '/api/projects/init-project') return send(200, { name: 'init-project', mainFile: 'main.md', format: 'markdown' })
    send(404, { error: `unexpected ${req.method} ${req.url}` })
  })
})

const socketPath = daemonLifecycleSocketPath(configDir, 'test')
const lifecycleRequests = []
const daemon = createNetServer({ allowHalfOpen: true }, socket => {
  let raw = ''
  socket.setEncoding('utf8')
  socket.on('data', chunk => { raw += chunk })
  socket.on('end', () => {
    lifecycleRequests.push(JSON.parse(raw))
    socket.end(`${JSON.stringify({ ok: true, result: { alreadyLinked: true, submission: { status: 'SubmittedToBuildQueue', revision: '1234567890abcdef' } } })}\n`)
  })
})

try {
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  await new Promise(resolve => daemon.listen(socketPath, resolve))
  const server = `http://127.0.0.1:${http.address().port}`
  const child = spawn(process.execPath, [join(process.cwd(), 'cli/tlda.mjs'), '--env', 'test', 'project', 'push', 'retry-project', '--dir', sourceDir, '--server', server], {
    cwd: sourceDir,
    env: {
      ...process.env,
      TLDA_CONFIG_DIR: configDir,
      TLDA_DAEMON_CONFIG_DIR: configDir,
      TLDA_ENV: 'test',
      TLDA_TOKEN: 'test-token',
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
    }, 15_000)
    child.on('error', reject)
    child.on('exit', code => { clearTimeout(timer); resolve(code) })
  })
  assert.equal(status, 0, stderr)
  assert.match(stdout, /Source pushed/)

  writeFileSync(join(sourceDir, 'main.md'), '# resumed link\n')
  const linked = spawn(process.execPath, [join(process.cwd(), 'cli/tlda.mjs'), '--env', 'test', 'project', 'link', 'linked-project', join(sourceDir, 'main.md'), '--format', 'markdown', '--server', server], {
    cwd: sourceDir,
    env: {
      ...process.env,
      TLDA_CONFIG_DIR: configDir,
      TLDA_DAEMON_CONFIG_DIR: configDir,
      TLDA_ENV: 'test',
      TLDA_TOKEN: 'test-token',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let linkedStdout = ''
  let linkedStderr = ''
  linked.stdout.on('data', chunk => { linkedStdout += chunk })
  linked.stderr.on('data', chunk => { linkedStderr += chunk })
  const linkedStatus = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      linked.kill('SIGTERM')
      reject(new Error(`linked CLI timed out\nstdout:\n${linkedStdout}\nstderr:\n${linkedStderr}`))
    }, 15_000)
    linked.on('error', reject)
    linked.on('exit', code => { clearTimeout(timer); resolve(code) })
  })
  assert.equal(linkedStatus, 0, linkedStderr)
  assert.equal(fileSnapshots, 0)
  assert.match(linkedStdout, /already linked/)
  assert.match(linkedStdout, /Submitted 1234567 through the daemon Git remote/)

  const initDir = join(root, 'init-project')
  mkdirSync(initDir)
  writeFileSync(join(initDir, 'main.md'), '# keep this text\n')
  execFileSync('git', ['init'], { cwd: initDir, stdio: 'ignore' })
  execFileSync('git', ['add', 'main.md'], { cwd: initDir, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'init: init-project (markdown)'], {
    cwd: initDir,
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 'tlda', GIT_COMMITTER_NAME: 'tlda', GIT_AUTHOR_EMAIL: 'tlda@localhost', GIT_COMMITTER_EMAIL: 'tlda@localhost' },
  })
  const initialized = spawn(process.execPath, [join(process.cwd(), 'cli/tlda.mjs'), '--env', 'test', 'project', 'init', 'init-project', 'main.md', '--dir', initDir, '--server', server], {
    cwd: root,
    env: {
      ...process.env,
      TLDA_CONFIG_DIR: configDir,
      TLDA_DAEMON_CONFIG_DIR: configDir,
      TLDA_ENV: 'test',
      TLDA_TOKEN: 'test-token',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let initStdout = ''
  let initStderr = ''
  initialized.stdout.on('data', chunk => { initStdout += chunk })
  initialized.stderr.on('data', chunk => { initStderr += chunk })
  const initStatus = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      initialized.kill('SIGTERM')
      reject(new Error(`init CLI timed out\nstdout:\n${initStdout}\nstderr:\n${initStderr}`))
    }, 15_000)
    initialized.on('error', reject)
    initialized.on('exit', code => { clearTimeout(timer); resolve(code) })
  })
  assert.equal(initStatus, 0, initStderr)
  assert.equal(fileSnapshots, 0)
  assert.match(initStdout, /Resuming tlda project init/)
  assert.equal(execFileSync('git', ['show', 'HEAD:main.md'], { cwd: initDir, encoding: 'utf8' }), '# keep this text\n')
  assert.ok(lifecycleRequests.every(request => request.op === 'project-source-link'))
} finally {
  await new Promise(resolve => http.close(resolve))
  await new Promise(resolve => daemon.close(resolve))
  rmSync(root, { recursive: true, force: true })
}

console.log('cli project completion boundary: ok')
