// Shared harness for the durable source wire tests.
//
// These spawn a real unified-server child process and drive a real daemon-side
// createSourceSync against it over a real WebSocket, so a test written with them
// crosses the boundary the feature crosses in production rather than calling
// both ends from one process.
//
// Extracted verbatim from durable-source-wire.test.mjs when a second test needed
// the same round trip; nothing here changed in the move.
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import WebSocket from 'ws'

export async function unusedPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

export async function startServer({ port, projectsDir, fleetDb, crashBoundary = null, bindingRegistry = null, helloDelayMs = null }) {
  const child = spawn(process.execPath, ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: join(import.meta.dirname, '..', '..'),
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      PROJECTS_DIR: projectsDir,
      TLDA_FLEET_DB: fleetDb,
      TLDA_DEV_SERVER: '1',
      TLDA_TASK_DOC_STARTUP_FLUSH_DELAY_MS: '-1',
      ...(bindingRegistry ? { TLDA_SOURCE_BINDING_REGISTRY_PATH: bindingRegistry } : {}),
      ...(crashBoundary ? { TLDA_TEST_SOURCE_CRASH_BOUNDARY: crashBoundary } : {}),
      ...(helloDelayMs != null ? { TLDA_TEST_DAEMON_HELLO_DELAY_MS: String(helloDelayMs) } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const deadline = Date.now() + 90_000
  while (!output.includes('Unified server running')) {
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}: ${output}`)
    if (Date.now() >= deadline) throw new Error(`server did not start: ${output}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return { child, output: () => output }
}

export async function stopServer(server) {
  if (!server || server.child.exitCode != null) return
  server.child.kill('SIGTERM')
  await new Promise(resolve => server.child.once('exit', resolve))
}

export async function openDaemon(port, { machineId = 'durable-source-wire', sourceBindings = [], onRpc = null } = {}) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws/fleet-daemon`, { rejectUnauthorized: false })
  ws._testMessages = []
  ws.on('message', raw => ws._testMessages.push(JSON.parse(String(raw))))
  if (onRpc) ws.on('message', raw => {
    const message = JSON.parse(String(raw))
    if (message.type !== 'rpc') return
    void Promise.resolve().then(() => onRpc(message)).then(
      result => ws.send(JSON.stringify({ type: 'rpc-reply', id: message.id, result })),
      error => ws.send(JSON.stringify({ type: 'rpc-reply', id: message.id, error: error?.message || String(error) })),
    )
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const welcome = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('daemon welcome timed out')), 20_000)
    const onMessage = raw => {
      const message = JSON.parse(String(raw))
      if (message.type !== 'daemon-welcome') return
      clearTimeout(timeout)
      ws.off('message', onMessage)
      resolve(message)
    }
    ws.on('message', onMessage)
  })
  ws.send(JSON.stringify({
    type: 'daemon-hello', machine_id: machineId, env_name: 'test', source_bindings: sourceBindings,
    boot_id: Date.now(), install_path: import.meta.dirname, hostname: 'test', version: 'test',
  }))
  await welcome
  return ws
}

export function nextRpc(ws, operation) {
  const existing = ws._testMessages.find(message => message.type === 'rpc' && message.op === operation)
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${operation} RPC timed out: ${JSON.stringify(ws._testMessages)}`)), 20_000)
    const onMessage = raw => {
      const message = JSON.parse(String(raw))
      if (message.type !== 'rpc' || message.op !== operation) return
      clearTimeout(timeout)
      ws.off('message', onMessage)
      resolve(message)
    }
    ws.on('message', onMessage)
  })
}

export function requestReply(ws, message) {
  return new Promise((resolve, reject) => {
    const id = message.id || `request-${Date.now()}-${Math.random()}`
    const timeout = setTimeout(() => reject(new Error(`request timed out: ${id}`)), 20_000)
    const onMessage = raw => {
      const reply = JSON.parse(String(raw))
      if (reply.id !== id) return
      clearTimeout(timeout)
      ws.off('message', onMessage)
      if (reply.error) reject(new Error(reply.error))
      else resolve(reply.result)
    }
    ws.on('message', onMessage)
    ws.send(JSON.stringify({ ...message, id }))
  })
}

export function deliver(ws, envelope) {
  return new Promise((resolve, reject) => {
    const received = []
    const timeout = setTimeout(() => reject(new Error(`delivery timed out: ${JSON.stringify(received)}`)), 20_000)
    ws.on('message', raw => {
      const message = JSON.parse(String(raw))
      received.push(message)
      if (message.type !== 'daemon-outbox-ack' || message.outbox_id !== envelope.__daemon_outbox_id) return
      clearTimeout(timeout)
      resolve(received)
    })
    ws.send(JSON.stringify(envelope))
  })
}

export function waitForMessage(ws, predicate, label) {
  const existing = ws._testMessages.find(predicate)
  if (existing) return Promise.resolve(existing)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} timed out: ${JSON.stringify(ws._testMessages)}`)), 20_000)
    const onMessage = raw => {
      const message = JSON.parse(String(raw))
      if (!predicate(message)) return
      clearTimeout(timeout)
      ws.off('message', onMessage)
      resolve(message)
    }
    ws.on('message', onMessage)
  })
}
