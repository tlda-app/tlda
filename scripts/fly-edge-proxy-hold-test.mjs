#!/usr/bin/env node
// The claim fly-edge-proxy.mjs makes is that a request survives the upstream
// disappearing and coming back — which is what `fly deploy` does to the app
// machine. So this drives the real script as a child process, over real sockets,
// and takes an upstream away and gives it back underneath a request in flight.
//
// AGENTS.md "Prove the wire, not the two ends": the interesting part is not that
// the proxy can connect, it is what it does in the seconds when there is nothing
// to connect to.
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const PROXY = join(here, 'fly-edge-proxy.mjs')

async function freePort() {
  const s = net.createServer()
  s.listen(0, '127.0.0.1')
  await once(s, 'listening')
  const { port } = s.address()
  await new Promise((r) => s.close(r))
  return port
}

function startUpstream(port, body) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(body)
  })
  server.listen(port, '127.0.0.1')
  return once(server, 'listening').then(() => server)
}

function stopUpstream(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(resolve)
  })
}

// Resolves with the body, or rejects — deliberately no timeout of its own, so a
// hung request shows up as the test timing out rather than as a pass.
function get(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', agent: false }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve(body))
    })
    req.on('error', reject)
  })
}

// In production this is plain `node scripts/fly-edge-proxy.mjs`. Under the suite
// runner NODE_OPTIONS carries `--import tsx`, and inheriting it makes every one
// of these children pay a loader it will never have on the box.
const cleanEnv = () => { const e = { ...process.env }; delete e.NODE_OPTIONS; return e }

function startProxy({ listenPort, upstreamPort, holdSeconds }) {
  const child = spawn(process.execPath, [PROXY], {
    env: {
      ...cleanEnv(),
      TLDA_EDGE_LISTEN_PORT: String(listenPort),
      TLDA_EDGE_UPSTREAM: `127.0.0.1:${upstreamPort}`,
      TLDA_EDGE_HOLD_SECONDS: String(holdSeconds),
      TLDA_EDGE_RETRY_MS: '100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines = []
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d) => lines.push(d))
  return { child, lines }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Wait on the proxy's own startup line rather than by connecting to it: a probe
// connection is itself a connection it would hold, which leaves a socket sitting
// out its whole hold window in the background of every case below.
async function waitForListening(lines) {
  for (let i = 0; i < 200; i++) {
    if (lines.join('').includes('holding up to')) return
    await sleep(25)
  }
  throw new Error('proxy never reported that it was listening')
}

// --- 1. A request that arrives while the upstream is absent is HELD, and is
//        answered by the upstream that shows up afterwards.
{
  const listenPort = await freePort()
  const upstreamPort = await freePort()
  const { child, lines } = startProxy({ listenPort, upstreamPort, holdSeconds: 20 })
  await waitForListening(lines)

  let settled = false
  const inFlight = get(listenPort).finally(() => { settled = true })

  await sleep(1000)
  assert.equal(settled, false, 'request should still be waiting while there is no upstream')

  const upstream = await startUpstream(upstreamPort, 'hello from the new machine')
  assert.equal(await inFlight, 'hello from the new machine')
  assert.match(lines.join(''), /held a connection \d+ms/, 'a held connection should say so in the log')

  await stopUpstream(upstream)
  child.kill()
}

// --- 2. The upstream going away and coming back — a deploy — is survived by a
//        request issued in the gap.
{
  const listenPort = await freePort()
  const upstreamPort = await freePort()
  const { child, lines } = startProxy({ listenPort, upstreamPort, holdSeconds: 20 })
  await waitForListening(lines)

  const before = await startUpstream(upstreamPort, 'old sha')
  assert.equal(await get(listenPort), 'old sha')

  await stopUpstream(before)
  const during = get(listenPort)
  await sleep(500)

  const after = await startUpstream(upstreamPort, 'new sha')
  assert.equal(await during, 'new sha', 'a request made during the swap should be answered by the new machine')

  await stopUpstream(after)
  child.kill()
}

// --- 3. The hold is a hold, not a hang: an upstream that never returns ends the
//        connection once the window is spent.
{
  const listenPort = await freePort()
  const upstreamPort = await freePort()
  const { child, lines } = startProxy({ listenPort, upstreamPort, holdSeconds: 1 })
  await waitForListening(lines)

  const startedAt = Date.now()
  await assert.rejects(get(listenPort), 'a permanently absent upstream must eventually fail the request')
  const waited = Date.now() - startedAt
  assert.ok(waited >= 900, `should have held for about the hold window, waited ${waited}ms`)

  child.kill()
}

// --- 4. WebSockets. The canvas and the fleet chat both ride on one, and a
//        proxy that only carried request/response would take them out on every
//        deploy while looking fine to curl. The pipe does not parse, so an
//        upgrade is just a connection that stays open — proved rather than
//        assumed, since it is the surface Skip is actually using.
{
  const { WebSocketServer, WebSocket } = await import('ws')
  const listenPort = await freePort()
  const upstreamPort = await freePort()
  const { child, lines } = startProxy({ listenPort, upstreamPort, holdSeconds: 20 })
  await waitForListening(lines)

  const wss = new WebSocketServer({ port: upstreamPort, host: '127.0.0.1' })
  wss.on('connection', (socket) => socket.on('message', (m) => socket.send(`echo:${m}`)))
  await once(wss, 'listening')

  const client = new WebSocket(`ws://127.0.0.1:${listenPort}/ws/fleet`)
  await once(client, 'open')
  client.send('still here')
  const [reply] = await once(client, 'message')
  assert.equal(String(reply), 'echo:still here')

  client.close()
  await new Promise((r) => wss.close(r))
  child.kill()
}

// --- 5. Every setting is required. A missing one must stop the process, not
//        become a guess about how long Skip waits.
for (const missing of ['TLDA_EDGE_LISTEN_PORT', 'TLDA_EDGE_UPSTREAM', 'TLDA_EDGE_HOLD_SECONDS', 'TLDA_EDGE_RETRY_MS']) {
  const env = {
    ...cleanEnv(),
    TLDA_EDGE_LISTEN_PORT: String(await freePort()),
    TLDA_EDGE_UPSTREAM: '127.0.0.1:1',
    TLDA_EDGE_HOLD_SECONDS: '1',
    TLDA_EDGE_RETRY_MS: '100',
  }
  delete env[missing]
  const child = spawn(process.execPath, [PROXY], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => { stderr += d })
  const [code] = await once(child, 'exit')
  assert.equal(code, 1, `${missing} missing should exit 1`)
  assert.match(stderr, new RegExp(`FATAL: ${missing} is not set`))
}

console.log('fly-edge-proxy: held through an absent upstream, survived a swap, expired its hold, and requires every setting')
