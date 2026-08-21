#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { daemonLifecycleSocketPath } from '../shared/daemon-socket-path.mjs'

const { sourceFileBatches, warnAboutFilesTooBigToCarry } = await import(`../cli/tlda.mjs?push-reporting-test=${Date.now()}`)

assert.deepEqual(
  sourceFileBatches([
    { path: 'a.qmd', size: 9 },
    { path: 'b.qmd', size: 2 },
    { path: 'c.qmd', size: 8 },
  ], 10).map(batch => batch.map(file => file.path)),
  [['a.qmd'], ['b.qmd', 'c.qmd']],
)

async function runCli(args, { cwd, env }) {
  const child = spawn(process.execPath, [join(process.cwd(), 'cli/tlda.mjs'), ...args], {
    cwd,
    env,
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
    }, 10_000)
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', code => {
      clearTimeout(timer)
      resolve(code)
    })
  })
  return { status, stdout, stderr }
}

const root = mkdtempSync(join(tmpdir(), 'tlda-cli-push-reporting-'))
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
writeFileSync(join(sourceDir, '_quarto_book.yml'), 'project:\n  type: book\n')
writeFileSync(join(sourceDir, 'chapter.qmd'), '# Chapter\n')

let pushRequests = 0
const http = createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  req.resume()
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/api/projects/rejecting-book') {
      send(200, { name: 'rejecting-book', mainFile: '_quarto_book.yml', format: 'qmd' })
    } else if (req.method === 'GET' && req.url === '/api/projects/rejecting-book/hashes') {
      send(200, { hashes: {} })
    } else if (req.method === 'POST' && req.url === '/api/projects/rejecting-book/source-room/files') {
      pushRequests += 1
      send(413, { error: 'payload too large from test server' })
    } else {
      send(404, { error: `unexpected ${req.method} ${req.url}` })
    }
  })
})

const socketPath = daemonLifecycleSocketPath(configDir, 'test')
const daemon = createNetServer(socket => {
  socket.setEncoding('utf8')
  socket.on('data', () => {
    socket.end(`${JSON.stringify({ ok: true, result: { alreadyLinked: false } })}\n`)
  })
})

try {
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  await new Promise(resolve => daemon.listen(socketPath, resolve))
  const server = `http://127.0.0.1:${http.address().port}`
  const result = await runCli([
    '--env', 'test',
    'project', 'push', 'rejecting-book',
    '--dir', sourceDir,
    '--server', server,
  ], {
    cwd: sourceDir,
    env: {
      ...process.env,
      TLDA_CONFIG_DIR: configDir,
      TLDA_DAEMON_CONFIG_DIR: configDir,
      TLDA_ENV: 'test',
      TLDA_TOKEN: 'test-token',
    },
  })
  assert.equal(pushRequests, 1, `precondition: CLI must reach /source-room/files\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  assert.notEqual(result.status, 0, `CLI must exit nonzero on HTTP 413\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
  assert.match(result.stderr, /payload too large from test server/)
  assert.doesNotMatch(result.stdout, /Build triggered|Source pushed|No changes detected/)
} finally {
  await new Promise(resolve => http.close(resolve))
  await new Promise(resolve => daemon.close(resolve))
  rmSync(root, { recursive: true, force: true })
}

console.log('PASS cli push reporting and batching')

// ## A file too big to carry says which file it is

// ### The bound cannot help a file bigger than itself
assert.deepEqual(
  sourceFileBatches([{ path: 'data.csv', size: 33 }, { path: 'main.tex', size: 1 }], 10)
    .map(batch => batch.map(file => file.path)),
  [['data.csv'], ['main.tex']],
  'the oversized file — goes out alone in a batch three times the bound; otherwise a file could be split '
  + 'across requests, which is not a thing that can be done to a file')

// ### So the person is told which one, before the push that cannot carry it
const warnings = []
const realWarn = console.warn
console.warn = (line) => warnings.push(String(line))
try {
  warnAboutFilesTooBigToCarry([
    { path: 'figures/scan.tiff', size: 33 * 1024 * 1024 },
    { path: 'main.tex', size: 2048 },
  ])
} finally {
  console.warn = realWarn
}
assert.equal(warnings.some(line => line.includes('figures/scan.tiff') && line.includes('33.0 MB')), true,
  'the warning — names the file and its size; otherwise the person watches a server disappear with no way '
  + 'to know which of 488 files did it, which is what happened on 2026-08-12')
assert.equal(warnings.some(line => line.includes('main.tex')), false,
  'the ordinary files — are not named, because a warning listing everything names nothing')

// ### Nothing is said when nothing is too big
const quiet = []
console.warn = (line) => quiet.push(String(line))
try {
  warnAboutFilesTooBigToCarry([{ path: 'main.tex', size: 2048 }])
} finally {
  console.warn = realWarn
}
assert.deepEqual(quiet, [],
  'an ordinary push — says nothing at all, so the warning means something when it appears')

console.log('cli push batching: an oversized file is named before the push that cannot carry it')
