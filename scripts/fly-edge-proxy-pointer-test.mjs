#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, connect } from 'node:net'
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function replyServer(text) {
  return createServer(socket => socket.end(text))
}

function read(port) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let body = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => { body += chunk })
    socket.on('end', () => resolve(body))
    socket.on('error', reject)
  })
}

const root = mkdtempSync(join(tmpdir(), 'tlda-edge-pointer-'))
const pointer = join(root, 'upstream')
const first = replyServer('first')
const second = replyServer('second')
let proxy
try {
  const firstPort = await listen(first)
  const secondPort = await listen(second)
  const probe = createServer()
  const proxyPort = await listen(probe)
  await new Promise(resolve => probe.close(resolve))
  const healthProbe = createServer()
  const healthPort = await listen(healthProbe)
  await new Promise(resolve => healthProbe.close(resolve))

  writeFileSync(pointer, `127.0.0.1:${firstPort}\n`)
  proxy = spawn(process.execPath, [join(here, 'fly-edge-proxy.mjs')], {
    env: {
      ...process.env,
      TLDA_EDGE_UPSTREAM_POINTER: pointer,
      TLDA_EDGE_LISTEN_PORT: String(proxyPort),
      TLDA_EDGE_HOLD_SECONDS: '2',
      TLDA_EDGE_RETRY_MS: '20',
      TLDA_EDGE_HEALTH_PORT: String(healthPort),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  await new Promise((resolve, reject) => {
    proxy.stdout.on('data', chunk => {
      if (String(chunk).includes(`health on :${healthPort}`)) resolve()
    })
    proxy.once('exit', code => reject(new Error(`proxy exited ${code}`)))
  })

  assert.equal(await read(proxyPort), 'first')
  const pending = `${pointer}.pending`
  writeFileSync(pending, `127.0.0.1:${secondPort}\n`)
  renameSync(pending, pointer)
  assert.equal(await read(proxyPort), 'second')

  writeFileSync(pending, 'not-an-upstream\n')
  renameSync(pending, pointer)
  assert.equal(await read(proxyPort), '')
  console.log('fly-edge-proxy pointer: new connections follow an atomic pointer swap and reject an invalid target')
} finally {
  proxy?.kill('SIGTERM')
  await Promise.all([
    new Promise(resolve => first.close(resolve)),
    new Promise(resolve => second.close(resolve)),
  ])
  rmSync(root, { recursive: true, force: true })
}
