import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'

import { DaemonDeliveryRuntime } from '../../daemon/delivery-runtime.mjs'
import { DaemonOutbox } from '../../daemon/outbox.mjs'
import { createSourceSync } from '../../daemon/source-sync.mjs'
import { closeProjectStore, createProject, initProjectStore, readSourceFile, sourceLifecycleStore, updateClientSourceManifest, updateProject } from './project-store.mjs'

async function unusedPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function startServer({ port, projectsDir, fleetDb, crashBoundary = null, bindingRegistry = null, helloDelayMs = null }) {
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

async function stopServer(server) {
  if (!server || server.child.exitCode != null) return
  server.child.kill('SIGTERM')
  await new Promise(resolve => server.child.once('exit', resolve))
}

async function openDaemon(port, { machineId = 'durable-source-wire', sourceBindings = [], onRpc = null } = {}) {
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

function nextRpc(ws, operation) {
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

function requestReply(ws, message) {
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

function deliver(ws, envelope) {
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

function waitForMessage(ws, predicate, label) {
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

test('daemon hello registers its binding before the next durable source frame', { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-source-hello-order-'))
  const projectsDir = join(root, 'projects')
  const fleetDb = join(root, 'fleet.db')
  const bindingRegistry = join(root, 'source-bindings.json')
  const project = 'paper-hello-order'
  const port = await unusedPort()
  const envelope = {
    type: 'source-change', project, requestId: 'R-hello-order', expectedRevision: null,
    sourceBindingId: 'binding-hello-order',
    files: [{ path: 'main.tex', content: 'ordered\n' }], deletedFiles: [], sourceManifest: ['main.tex'],
    __daemon_outbox_id: 'D-hello-order',
  }
  let server
  let ws
  try {
    await initProjectStore(projectsDir)
    createProject({ name: project, mainFile: 'main.tex', format: 'svg' })
    await updateProject(project, { pages: 1, buildStatus: 'success' })
    mkdirSync(join(projectsDir, project, 'output'), { recursive: true })
    writeFileSync(join(projectsDir, project, 'output', 'relevant-files.json'), JSON.stringify(['other.tex']))
    await closeProjectStore()

    server = await startServer({ port, projectsDir, fleetDb, bindingRegistry, helloDelayMs: 100 })
    ws = new WebSocket(`wss://127.0.0.1:${port}/ws/fleet-daemon`, { rejectUnauthorized: false })
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    const delivered = new Promise((resolve, reject) => {
      const received = []
      const timeout = setTimeout(() => reject(new Error(`delivery timed out: ${JSON.stringify(received)}`)), 20_000)
      ws.on('message', raw => {
        const message = JSON.parse(String(raw))
        received.push(message)
        if (message.type !== 'daemon-outbox-ack' || message.outbox_id !== envelope.__daemon_outbox_id) return
        clearTimeout(timeout)
        resolve(received)
      })
    })
    ws.send(JSON.stringify({
      type: 'daemon-hello', machine_id: 'hello-order-machine', env_name: 'test',
      source_bindings: [{ bindingId: envelope.sourceBindingId, project }],
      boot_id: Date.now(), install_path: import.meta.dirname, hostname: 'test', version: 'test',
    }))
    ws.send(JSON.stringify(envelope))
    const messages = await delivered
    const result = messages.find(message => message.type === 'source-change-result')
    assert.equal(result?.ok, true, `${JSON.stringify(messages)}\n${server.output()}`)
    assert.equal(readFileSync(join(projectsDir, project, 'source', 'main.tex'), 'utf8'), 'ordered\n')
  } finally {
    ws?.terminate()
    await stopServer(server)
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('new source binding is accepted on the existing daemon connection', { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-source-live-binding-'))
  const projectsDir = join(root, 'projects')
  const fleetDb = join(root, 'fleet.db')
  const bindingRegistry = join(root, 'source-bindings.json')
  const project = 'paper-live-binding'
  const bindingId = 'binding-added-after-hello'
  const port = await unusedPort()
  let server
  let ws
  try {
    await initProjectStore(projectsDir)
    createProject({ name: project, mainFile: 'main.tex', format: 'svg' })
    await updateProject(project, { pages: 1, buildStatus: 'success' })
    mkdirSync(join(projectsDir, project, 'output'), { recursive: true })
    writeFileSync(join(projectsDir, project, 'output', 'relevant-files.json'), JSON.stringify(['other.tex']))
    await closeProjectStore()

    server = await startServer({ port, projectsDir, fleetDb, bindingRegistry })
    ws = await openDaemon(port, { machineId: 'live-binding-machine', sourceBindings: [] })
    assert.deepEqual(await requestReply(ws, {
      type: 'source-bindings-set',
      source_bindings: [{ bindingId, project }],
    }), { ok: true })

    const messages = await deliver(ws, {
      type: 'source-change', project, requestId: 'R-live-binding', expectedRevision: null,
      sourceBindingId: bindingId,
      files: [{ path: 'main.tex', content: 'linked without reconnect\n' }],
      deletedFiles: [], sourceManifest: ['main.tex'], __daemon_outbox_id: 'D-live-binding',
    })
    const accepted = messages.find(message => message.type === 'source-change-result')
    assert.equal(accepted?.ok, true, JSON.stringify(messages))
    assert.equal(readFileSync(join(projectsDir, project, 'source', 'main.tex'), 'utf8'), 'linked without reconnect\n')
    const registry = JSON.parse(readFileSync(bindingRegistry, 'utf8'))
    assert.equal(registry.bindings[bindingId].daemonKey, 'live-binding-machine:test')
  } finally {
    ws?.terminate()
    await stopServer(server)
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('processed source change without terminal operation is permanently retired across restart', { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-source-terminal-rejection-'))
  const projectsDir = join(root, 'projects')
  const fleetDb = join(root, 'fleet.db')
  const bindingRegistry = join(root, 'source-bindings.json')
  const outboxPath = join(root, 'daemon-outbox.sqlite')
  const project = 'permanently-rejected-source-project'
  const bindingId = 'registered-source-binding'
  const outboxId = 'D-deleted-source'
  const port = await unusedPort()
  const envelope = {
    type: 'source-change', project, requestId: 'R-deleted-source', expectedRevision: null,
    sourceBindingId: 'invalid-source-binding',
    files: [{ path: 'main.tex', content: 'never accepted\n' }],
    deletedFiles: [], sourceManifest: ['main.tex'], __daemon_outbox_id: outboxId,
  }
  let server
  let ws
  let outbox
  let delivery
  try {
    await initProjectStore(projectsDir)
    createProject({ name: project, mainFile: 'main.tex', format: 'svg' })
    await updateProject(project, { pages: 1, buildStatus: 'success' })
    await closeProjectStore()
    server = await startServer({ port, projectsDir, fleetDb, bindingRegistry })
    ws = await openDaemon(port, {
      machineId: 'terminal-rejection-machine',
      sourceBindings: [{ bindingId, project }],
    })
    outbox = new DaemonOutbox(outboxPath)
    delivery = new DaemonDeliveryRuntime({
      outbox,
      send(message) { ws.send(JSON.stringify(message)); return true },
      isConnected: () => true,
      isReady: () => true,
    })
    delivery.send(envelope)
    await waitForMessage(ws, message => message.type === 'daemon-outbox-ack' && message.outbox_id === outboxId, 'initial processed ACK')
    assert.equal(outbox.get(outboxId).attempts, 1)

    delivery.dispose()
    delivery = null
    ws.terminate()
    ws = null
    outbox.close()
    outbox = null
    await stopServer(server)
    server = null

    server = await startServer({ port, projectsDir, fleetDb, bindingRegistry })
    ws = await openDaemon(port, {
      machineId: 'terminal-rejection-machine',
      sourceBindings: [{ bindingId, project }],
    })
    outbox = new DaemonOutbox(outboxPath)
    let deadLetters = 0
    delivery = new DaemonDeliveryRuntime({
      outbox,
      send(message) { ws.send(JSON.stringify(message)); return true },
      isConnected: () => true,
      isReady: () => true,
      onDeadLetter() { deadLetters++ },
    })
    ws.on('message', raw => {
      const message = JSON.parse(String(raw))
      if (message.type === 'daemon-outbox-error') {
        delivery.handleError(message.outbox_id, message.error, { permanent: message.permanent === true })
      }
    })
    delivery.noteReady()
    await waitForMessage(ws, message => message.type === 'daemon-outbox-error' && message.outbox_id === outboxId, 'permanent replay rejection')
    const deadline = Date.now() + 5000
    while (!outbox.get(outboxId)?.deadLetteredAt && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const terminal = outbox.get(outboxId)
    assert.ok(terminal.deadLetteredAt)
    assert.match(terminal.deadLetterReason, /has no terminal source operation/)
    assert.equal(terminal.attempts, 2)
    assert.equal(deadLetters, 1)
    assert.equal(outbox.pendingCount(), 0)

    delivery.dispose()
    delivery = null
    outbox.close()
    outbox = new DaemonOutbox(outboxPath)
    let repeatedSends = 0
    delivery = new DaemonDeliveryRuntime({
      outbox,
      send() { repeatedSends++; return true },
      isConnected: () => true,
      isReady: () => true,
    })
    delivery.noteReady()
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(repeatedSends, 0)
    assert.equal(outbox.pendingCount(), 0)
  } finally {
    delivery?.dispose()
    outbox?.close()
    ws?.terminate()
    await stopServer(server)
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('two independent daemon writers interleave against one accepted source revision', { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-source-two-writer-wire-'))
  const projectsDir = join(root, 'projects')
  const fleetDb = join(root, 'fleet.db')
  const bindingRegistry = join(root, 'source-bindings.json')
  const project = 'paper-two-writer-wire'
  const port = await unusedPort()
  let server
  let firstWs
  let secondWs
  try {
    await initProjectStore(projectsDir)
    createProject({ name: project, mainFile: 'main.tex', format: 'svg' })
    await updateProject(project, { pages: 1, buildStatus: 'success' })
    mkdirSync(join(projectsDir, project, 'output'), { recursive: true })
    writeFileSync(join(projectsDir, project, 'output', 'relevant-files.json'), JSON.stringify(['other.tex']))
    const lifecycle = await sourceLifecycleStore(project, { context: { referencedRoots: ['main.tex'] } })
    const base = lifecycle.bootstrap({
      expectedRevision: null,
      files: [{ path: 'main.tex', content: 'base\n' }],
      sourceManifest: ['main.tex'],
    })
    assert.equal(base.ok, true)
    await closeProjectStore()

    server = await startServer({ port, projectsDir, fleetDb, bindingRegistry })
    firstWs = await openDaemon(port, {
      machineId: 'writer-one-machine',
      sourceBindings: [{ bindingId: 'writer-one-binding', project }],
    })
    secondWs = await openDaemon(port, {
      machineId: 'writer-two-machine',
      sourceBindings: [{ bindingId: 'writer-two-binding', project }],
    })

    const changes = [
      {
        type: 'source-change', project, requestId: 'R-writer-one',
        expectedRevision: base.authority.currentRevision, sourceBindingId: 'writer-one-binding',
        files: [{ path: 'main.tex', content: 'writer one\n' }], deletedFiles: [], sourceManifest: ['main.tex'],
        editedBy: 'fleet:writer-one', __daemon_outbox_id: 'D-writer-one',
      },
      {
        type: 'source-change', project, requestId: 'R-writer-two',
        expectedRevision: base.authority.currentRevision, sourceBindingId: 'writer-two-binding',
        files: [{ path: 'main.tex', content: 'writer two\n' }], deletedFiles: [], sourceManifest: ['main.tex'],
        editedBy: 'fleet:writer-two', __daemon_outbox_id: 'D-writer-two',
      },
    ]
    const deliveries = await Promise.all([
      deliver(firstWs, changes[0]),
      deliver(secondWs, changes[1]),
    ])
    const results = deliveries.map(messages => messages.find(message => message.type === 'source-change-result'))
    const acceptedIndex = results.findIndex(result => result?.ok === true)
    const rejectedIndex = results.findIndex(result => result?.status === 'stale-base')
    assert.notEqual(acceptedIndex, -1, JSON.stringify(deliveries))
    assert.notEqual(rejectedIndex, -1, JSON.stringify(deliveries))
    assert.notEqual(acceptedIndex, rejectedIndex)
    assert.equal(results[rejectedIndex].httpStatus, 409)
    assert.equal(
      readFileSync(join(projectsDir, project, 'source', 'main.tex'), 'utf8'),
      changes[acceptedIndex].files[0].content,
    )
  } finally {
    firstWs?.terminate()
    secondWs?.terminate()
    await stopServer(server)
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})

test('offline binding remains required and completes when its daemon reconnects', { timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'tlda-source-offline-wire-'))
  const projectsDir = join(root, 'projects')
  const fleetDb = join(root, 'fleet.db')
  const bindingRegistry = join(root, 'source-bindings.json')
  const project = 'paper-offline-binding'
  const port = await unusedPort()
  let server
  let sourceWs
  let targetWs
  let targetSync
  try {
    await initProjectStore(projectsDir)
    createProject({ name: project, mainFile: 'main.tex', format: 'svg' })
    await updateProject(project, { pages: 1, buildStatus: 'success' })
    mkdirSync(join(projectsDir, project, 'output'), { recursive: true })
    writeFileSync(join(projectsDir, project, 'output', 'relevant-files.json'), JSON.stringify(['other.tex']))
    mkdirSync(join(projectsDir, project, 'source'), { recursive: true })
    writeFileSync(join(projectsDir, project, 'source', 'main.tex'), 'base main\n')
    writeFileSync(join(projectsDir, project, 'source', 'delete.tex'), 'delete me\n')
    await updateClientSourceManifest(project, ['delete.tex', 'main.tex'])
    const lifecycle = await sourceLifecycleStore(project, { context: { referencedRoots: ['delete.tex', 'main.tex'] } })
    const base = lifecycle.bootstrap({
      expectedRevision: null,
      sourceManifest: ['delete.tex', 'main.tex'],
      files: [
        { path: 'delete.tex', content: 'delete me\n' },
        { path: 'main.tex', content: 'base main\n' },
      ],
    })
    assert.equal(base.ok, true)
    await closeProjectStore()

    const targetDir = join(root, 'target-checkout')
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, 'main.tex'), 'base main\n')
    writeFileSync(join(targetDir, 'delete.tex'), 'delete me\n')
    writeFileSync(join(targetDir, 'unmanaged.txt'), 'keep me\n')
    const watcher = new EventEmitter()
    watcher.close = () => Promise.resolve()
    const targetSent = []
    targetSync = createSourceSync({
      sourceBindingsFile: join(root, 'target-bindings.json'),
      log: { info() {}, warn() {}, error() {} },
      sendMsg(message) { targetSent.push(message); return true },
      isConnected: () => true,
      resolveEditor: () => null,
      reconcileIntervalMs: 60_000,
      watch() { return watcher },
    })
    const targetBinding = targetSync.bindSource(project, targetDir)
    targetSync.sync([{
      name: project, sourceDir: targetDir, mainFile: 'main.tex', format: 'svg',
      sourceRevision: base.authority.currentRevision,
      sourceManifest: ['delete.tex', 'main.tex'],
    }], { authoritativeRevisions: true })

    server = await startServer({ port, projectsDir, fleetDb, bindingRegistry })
    targetWs = await openDaemon(port, {
      machineId: 'target-machine',
      sourceBindings: [{ bindingId: targetBinding.bindingId, project }],
    })
    targetWs.close()
    await new Promise(resolve => targetWs.once('close', resolve))
    targetWs = null

    sourceWs = await openDaemon(port, {
      machineId: 'source-machine',
      sourceBindings: [{ bindingId: 'source-binding', project }],
    })
    const envelope = {
      type: 'source-change', project, requestId: 'R-offline', expectedRevision: base.authority.currentRevision,
      sourceBindingId: 'source-binding',
      files: [
        { path: 'main.tex', content: 'changed main\n' },
        { path: 'added.tex', content: 'added file\n' },
      ],
      deletedFiles: ['delete.tex'], sourceManifest: ['added.tex', 'main.tex'], editedBy: 'agent',
      __daemon_outbox_id: 'D-offline',
    }
    const rejectedMessages = await deliver(sourceWs, {
      ...envelope,
      requestId: 'R-invalid-origin',
      sourceBindingId: targetBinding.bindingId,
      __daemon_outbox_id: 'D-invalid-origin',
    })
    const rejected = rejectedMessages.find(message => message.type === 'source-change-result')
    assert.equal(rejected?.status, 'invalid-source-binding')
    assert.equal(rejected?.httpStatus, 403)
    const acceptedMessages = await deliver(sourceWs, envelope)
    const accepted = acceptedMessages.find(message => message.type === 'source-change-result')
    assert.equal(accepted?.ok, true, JSON.stringify(acceptedMessages))
    const registry = JSON.parse(readFileSync(bindingRegistry, 'utf8'))
    assert.equal(registry.bindings[targetBinding.bindingId].daemonKey, 'target-machine:test')
    const operations = JSON.parse(readFileSync(join(projectsDir, project, '.source-lifecycle', 'operations.json'), 'utf8'))
    assert.equal(operations.revisionLifecycle[accepted.sourceRevision].replicas[targetBinding.bindingId].state, 'pending')

    targetWs = await openDaemon(port, {
      machineId: 'target-machine',
      sourceBindings: [{ bindingId: targetBinding.bindingId, project }],
      onRpc: async message => {
        const result = targetSync.applyAcceptedSourceUpdate(message)
        for (const file of ['main.tex', 'added.tex', 'delete.tex']) {
          watcher.emit(file === 'delete.tex' ? 'unlink' : 'change', join(targetDir, file))
        }
        await new Promise(resolve => setTimeout(resolve, 250))
        return result
      },
    })
    const rpc = await nextRpc(targetWs, 'apply-source-update').catch(error => {
      throw new Error(`${error.message}\nserver log:\n${server.output()}`)
    })
    assert.equal(rpc.bindingId, targetBinding.bindingId)
    assert.equal(rpc.sourceRevision, accepted.sourceRevision)
    await new Promise(resolve => setTimeout(resolve, 350))
    assert.equal(readFileSync(join(targetDir, 'main.tex'), 'utf8'), 'changed main\n')
    assert.equal(readFileSync(join(targetDir, 'added.tex'), 'utf8'), 'added file\n')
    assert.equal(existsSync(join(targetDir, 'delete.tex')), false)
    assert.equal(readFileSync(join(targetDir, 'unmanaged.txt'), 'utf8'), 'keep me\n')
    assert.equal(targetSent.filter(message => message.type === 'source-change').length, 0)

    sourceWs.close()
    targetWs.close()
    sourceWs = null
    targetWs = null
    await stopServer(server)
    await initProjectStore(projectsDir)
    const restartedLifecycle = await sourceLifecycleStore(project)
    assert.equal(restartedLifecycle.readRevisionLifecycle(project, accepted.sourceRevision).replicas[targetBinding.bindingId].state, 'materialized')
  } finally {
    await targetSync?.closeAll()
    sourceWs?.terminate()
    targetWs?.terminate()
    await stopServer(server)
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
})

for (const boundary of ['after-source-mutation', 'after-terminal-result']) {
  test(`production daemon wire replays exact canonical result after ${boundary} restart`, { timeout: 180_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'tlda-source-wire-'))
    const projectsDir = join(root, 'projects')
    const fleetDb = join(root, 'fleet.db')
    const bindingRegistry = join(root, 'server-source-bindings.json')
    const project = `paper-${boundary}`
    const machineId = `durable-source-wire-${boundary}`
    const port = await unusedPort()
    const operation = { operation_id: `O-${boundary}`, kind: 'Edit', files: [{ path: 'main.tex' }] }
    const envelope = {
      type: 'source-change', project, requestId: `R-${boundary}`, expectedRevision: null,
      sourceBindingId: `binding-${boundary}`,
      files: [{ path: 'main.tex', content: `content-${boundary}\n` }], deletedFiles: [], sourceManifest: ['main.tex'],
      editedBy: 'agent', editOperations: [{ agentId: 'agent', operation }], __daemon_outbox_id: `D-${boundary}`,
    }
    let server
    let ws
    try {
      await initProjectStore(projectsDir)
      createProject({ name: project, mainFile: 'main.tex', format: 'svg' })
      await updateProject(project, { pages: 1, buildStatus: 'success' })
      mkdirSync(join(projectsDir, project, 'output'), { recursive: true })
      writeFileSync(join(projectsDir, project, 'output', 'relevant-files.json'), JSON.stringify(['other.tex']))
      await closeProjectStore()

      server = await startServer({ port, projectsDir, fleetDb, bindingRegistry, crashBoundary: boundary })
      ws = await openDaemon(port, { machineId, sourceBindings: [{ bindingId: `binding-${boundary}`, project }] })
      const beforeCrash = []
      ws.on('message', raw => { beforeCrash.push(JSON.parse(String(raw))) })
      ws.send(JSON.stringify(envelope))
      await new Promise((resolve, reject) => {
        server.child.once('exit', resolve)
        setTimeout(() => reject(new Error(`server did not crash at ${boundary}; received=${JSON.stringify(beforeCrash)}: ${server.output()}`)), 20_000)
      })
      ws.terminate()
      ws = null

      server = await startServer({ port, projectsDir, fleetDb, bindingRegistry })
      ws = await openDaemon(port, { machineId, sourceBindings: [{ bindingId: `binding-${boundary}`, project }] })
      const acceptedMessages = await deliver(ws, envelope)
      const acceptedResult = acceptedMessages.find(message => message.type === 'source-change-result')
      assert.ok(acceptedResult)
      assert.equal(acceptedResult.ok, true, JSON.stringify(acceptedMessages))
      assert.deepEqual(acceptedMessages.slice(-2), [acceptedResult, { type: 'daemon-outbox-ack', outbox_id: envelope.__daemon_outbox_id }])
      const acceptedFile = join(projectsDir, project, 'source', 'main.tex')
      assert.equal(existsSync(acceptedFile), true, `accepted file missing: ${acceptedFile}; messages=${JSON.stringify(acceptedMessages)}; log=${server.output()}`)
      assert.equal(readFileSync(acceptedFile, 'utf8'), `content-${boundary}\n`)
      ws.close()
      ws = null
      await stopServer(server)

      await initProjectStore(projectsDir)
      assert.equal(readSourceFile(project, 'main.tex'), `content-${boundary}\n`)
      const lifecycle = await sourceLifecycleStore(project)
      const byRequest = lifecycle.readOperationByRequestId(project, envelope.requestId)
      const byDelivery = lifecycle.readOperationByDeliveryId(project, envelope.__daemon_outbox_id)
      assert.deepEqual(byDelivery, byRequest)
      assert.deepEqual(byRequest.terminalResult.operationIds, [operation.operation_id])
      await closeProjectStore()

      server = await startServer({ port, projectsDir, fleetDb, bindingRegistry })
      ws = await openDaemon(port, { machineId, sourceBindings: [{ bindingId: `binding-${boundary}`, project }] })
      const replayMessages = await deliver(ws, envelope)
      assert.deepEqual(replayMessages, [acceptedResult, { type: 'daemon-outbox-ack', outbox_id: envelope.__daemon_outbox_id }])
    } finally {
      ws?.terminate()
      await stopServer(server)
      await closeProjectStore()
      rmSync(root, { recursive: true, force: true })
    }
  })
}
