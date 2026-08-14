import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'

import { closeProjectStore, createProject, initProjectStore, readSourceFile, sourceLifecycleStore, updateProject } from './project-store.mjs'

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

async function startServer({ port, projectsDir, fleetDb, crashBoundary = null }) {
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
      ...(crashBoundary ? { TLDA_TEST_SOURCE_CRASH_BOUNDARY: crashBoundary } : {}),
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

async function openDaemon(port) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws/fleet-daemon`, { rejectUnauthorized: false })
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
    type: 'daemon-hello', machine_id: 'durable-source-wire', env_name: 'test',
    boot_id: Date.now(), install_path: import.meta.dirname, hostname: 'test', version: 'test',
  }))
  await welcome
  return ws
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

for (const boundary of ['after-source-mutation', 'after-terminal-result']) {
  test(`production daemon wire replays exact canonical result after ${boundary} restart`, { timeout: 180_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'tlda-source-wire-'))
    const projectsDir = join(root, 'projects')
    const fleetDb = join(root, 'fleet.db')
    const project = `paper-${boundary}`
    const port = await unusedPort()
    const operation = { operation_id: `O-${boundary}`, kind: 'Edit', files: [{ path: 'main.tex' }] }
    const envelope = {
      type: 'source-change', project, requestId: `R-${boundary}`, expectedRevision: null,
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

      server = await startServer({ port, projectsDir, fleetDb, crashBoundary: boundary })
      ws = await openDaemon(port)
      const beforeCrash = []
      ws.on('message', raw => { beforeCrash.push(JSON.parse(String(raw))) })
      ws.send(JSON.stringify(envelope))
      await new Promise((resolve, reject) => {
        server.child.once('exit', resolve)
        setTimeout(() => reject(new Error(`server did not crash at ${boundary}; received=${JSON.stringify(beforeCrash)}: ${server.output()}`)), 20_000)
      })
      ws.terminate()
      ws = null

      server = await startServer({ port, projectsDir, fleetDb })
      ws = await openDaemon(port)
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

      server = await startServer({ port, projectsDir, fleetDb })
      ws = await openDaemon(port)
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
