#!/usr/bin/env node
//
// Adversarial daemon-sync convergence harness.
//
// The full state machine starts with a Git-backed daemon registration because
// every later transition depends on the server being able to address that
// logical copy: fetch, fast-forward/auto-merge, materialize its unresolved
// branch through the ordinary editor/MCP working copy, accept the resolution,
// and drive every replica to a fixed point.
//
// Do not replace this gate with a fake Git participant. A fake would let the
// edit/sync scheduler prove its own model while bypassing the production
// daemon/server wire that is the subject of the test. The positive assertions
// below first prove that the real registration frame crossed and was persisted;
// the final assertions distinguish that working wire from the missing
// Git-backed daemon behavior.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  closeProjectStore,
  createProject,
  initProjectStore,
  sourceLifecycleStore,
  updateClientSourceManifest,
  updateProject,
} from '../server/lib/project-store.mjs'
import { createSourceSync } from '../daemon/source-sync.mjs'
import {
  deliver,
  openDaemon,
  requestReply,
  startServer,
  stopServer,
  unusedPort,
} from '../server/lib/durable-source-wire-harness.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-sync-convergence-machine-'))
const projectsDir = join(root, 'projects')
const fleetDb = join(root, 'fleet.db')
const bindingRegistry = join(root, 'server-source-bindings.json')
const remote = join(root, 'remote.git')
const project = 'convergence-paper'
const bindingId = 'git-backed-daemon-binding'
const port = await unusedPort()
let server
let ws
let peerWs
let targetWs
let targetSync

try {
  execFileSync('git', ['init', '--bare', '--quiet', remote])

  await initProjectStore(projectsDir)
  createProject({ name: project, mainFile: 'main.tex', format: 'svg' })
  await updateProject(project, { pages: 1, buildStatus: 'success' })
  mkdirSync(join(projectsDir, project, 'output'), { recursive: true })
  writeFileSync(join(projectsDir, project, 'output', 'relevant-files.json'), JSON.stringify(['render-only.tex']))
  mkdirSync(join(projectsDir, project, 'source'), { recursive: true })
  writeFileSync(join(projectsDir, project, 'source', 'main.tex'), 'revision-0:main\n')
  writeFileSync(join(projectsDir, project, 'source', 'part.tex'), 'revision-0:part\n')
  await updateClientSourceManifest(project, ['main.tex', 'part.tex'])
  const lifecycle = await sourceLifecycleStore(project, { context: { referencedRoots: ['main.tex', 'part.tex'] } })
  const bootstrap = await lifecycle.bootstrap({
    expectedRevision: null,
    sourceManifest: ['main.tex', 'part.tex'],
    files: [
      { path: 'main.tex', content: 'revision-0:main\n' },
      { path: 'part.tex', content: 'revision-0:part\n' },
    ],
  })
  assert.equal(bootstrap.ok, true)
  await closeProjectStore()

  const targetDir = join(root, 'materialized-checkout')
  mkdirSync(targetDir, { recursive: true })
  writeFileSync(join(targetDir, 'main.tex'), 'revision-0:main\n')
  writeFileSync(join(targetDir, 'part.tex'), 'revision-0:part\n')
  const watcher = new EventEmitter()
  watcher.close = () => Promise.resolve()
  targetSync = createSourceSync({
    sourceChangeSettleDeadlineMs: 300_000,
    sourceBindingsFile: join(root, 'target-bindings.json'),
    log: { info() {}, warn() {}, error() {} },
    sendMsg() { return true },
    isConnected: () => true,
    resolveEditor: () => null,
    reconcileIntervalMs: 60_000,
    watch() { return watcher },
  })
  const targetBinding = targetSync.bindSource(project, targetDir)
  targetSync.sync([{
    name: project,
    sourceDir: targetDir,
    mainFile: 'main.tex',
    format: 'svg',
    sourceRevision: bootstrap.authority.currentRevision,
    sourceManifest: ['main.tex', 'part.tex'],
  }], { authoritativeRevisions: true })

  server = await startServer({ port, projectsDir, fleetDb, bindingRegistry })
  targetWs = await openDaemon(port, {
    machineId: 'materialized-machine',
    sourceBindings: [{ bindingId: targetBinding.bindingId, project }],
    onRpc: async message => message.op === 'apply-source-update'
      ? targetSync.applyAcceptedSourceUpdate(message)
      : message.op === 'mirror-shadow-ref'
        ? ({ ok: true, project })
        : ({ ok: false, reason: 'project-not-watched' }),
  })
  targetWs.close()
  await new Promise(resolve => targetWs.once('close', resolve))
  targetWs = null
  ws = await openDaemon(port, {
    machineId: 'writer-one-machine',
    sourceBindings: [{ bindingId: 'writer-one-binding', project }],
    onRpc: async message => message.op === 'mirror-shadow-ref'
      ? ({ ok: true, project })
      : ({ ok: false, reason: 'project-not-watched' }),
  })
  peerWs = await openDaemon(port, {
    machineId: 'writer-two-machine',
    sourceBindings: [{ bindingId: 'writer-two-binding', project }],
    onRpc: async () => ({ ok: false, reason: 'project-not-watched' }),
  })

  let acceptedRevision = bootstrap.authority.currentRevision
  let acceptedOrdinal = 0
  const writers = [
    { ws, bindingId: 'writer-one-binding', name: 'writer-one' },
    { ws: peerWs, bindingId: 'writer-two-binding', name: 'writer-two' },
  ]
  for (const [step, writerIndex] of [0, 1, 1, 0, 1, 0].entries()) {
    const writer = writers[writerIndex]
    const ordinal = step + 1
    const files = [
      { path: 'main.tex', content: `revision-${ordinal}:main\n` },
      { path: 'part.tex', content: `revision-${ordinal}:part\n` },
    ]

    // Every other edit is first interleaved against the previous fixed point.
    // It must be rejected as a unit: neither file may leak into authority or
    // the materialized checkout before the same edit is retried from the head.
    if (step > 0 && step % 2 === 1) {
      const staleBase = bootstrap.authority.currentRevision
      const staleMessages = await deliver(writer.ws, {
        type: 'source-change', project, requestId: `R-stale-${step}`,
        expectedRevision: staleBase, sourceBindingId: writer.bindingId,
        files, deletedFiles: [], sourceManifest: ['main.tex', 'part.tex'],
        editedBy: writer.name, __daemon_outbox_id: `D-stale-${step}`,
      })
      const stale = staleMessages.find(message => message.type === 'source-change-result')
      assert.equal(stale?.status, 'stale-base', JSON.stringify(staleMessages))
      assert.equal(readFileSync(join(projectsDir, project, 'source', 'main.tex'), 'utf8'), `revision-${acceptedOrdinal}:main\n`)
      assert.equal(readFileSync(join(projectsDir, project, 'source', 'part.tex'), 'utf8'), `revision-${acceptedOrdinal}:part\n`)
    }

    const acceptedMessages = await deliver(writer.ws, {
      type: 'source-change', project, requestId: `R-accepted-${step}`,
      expectedRevision: acceptedRevision, sourceBindingId: writer.bindingId,
      files, deletedFiles: [], sourceManifest: ['main.tex', 'part.tex'],
      editedBy: writer.name, __daemon_outbox_id: `D-accepted-${step}`,
    })
    const accepted = acceptedMessages.find(message => message.type === 'source-change-result')
    assert.equal(accepted?.ok, true, JSON.stringify(acceptedMessages))
    acceptedRevision = accepted.sourceRevision
    acceptedOrdinal = ordinal

    targetWs = await openDaemon(port, {
      machineId: 'materialized-machine',
      sourceBindings: [{ bindingId: targetBinding.bindingId, project }],
      onRpc: async message => message.op === 'apply-source-update'
        ? targetSync.applyAcceptedSourceUpdate(message)
        : ({ ok: false, reason: 'project-not-watched' }),
    })
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (
        existsSync(join(targetDir, 'main.tex'))
        && readFileSync(join(targetDir, 'main.tex'), 'utf8') === `revision-${ordinal}:main\n`
        && readFileSync(join(targetDir, 'part.tex'), 'utf8') === `revision-${ordinal}:part\n`
      ) break
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(readFileSync(join(targetDir, 'main.tex'), 'utf8'), `revision-${ordinal}:main\n`)
    assert.equal(readFileSync(join(targetDir, 'part.tex'), 'utf8'), `revision-${ordinal}:part\n`)
    targetWs.close()
    await new Promise(resolve => targetWs.once('close', resolve))
    targetWs = null
  }

  // Fixed point: after the finite scheduler stops, authority and the reachable
  // materialization hold one complete accepted revision, never a mixed pair.
  assert.equal(readFileSync(join(projectsDir, project, 'source', 'main.tex'), 'utf8'), `revision-${acceptedOrdinal}:main\n`)
  assert.equal(readFileSync(join(projectsDir, project, 'source', 'part.tex'), 'utf8'), `revision-${acceptedOrdinal}:part\n`)
  assert.equal(readFileSync(join(targetDir, 'main.tex'), 'utf8'), `revision-${acceptedOrdinal}:main\n`)
  assert.equal(readFileSync(join(targetDir, 'part.tex'), 'utf8'), `revision-${acceptedOrdinal}:part\n`)

  // Replace the writer registration with the Git-backed identity required by
  // the next state-machine phase. The first missing production behavior below
  // remains the gate; no fake Git participant is substituted for it.
  ws.terminate()
  ws = await openDaemon(port, { machineId: 'git-backed-machine', sourceBindings: [] })

  const registration = {
    bindingId,
    project,
    kind: 'git',
    remote,
    mirrorMode: 'auto-merge',
  }
  assert.deepEqual(
    await requestReply(ws, { type: 'source-bindings-set', source_bindings: [registration] }),
    { ok: true },
    'the production daemon/server wire must acknowledge the registration frame',
  )

  const registry = JSON.parse(readFileSync(bindingRegistry, 'utf8'))
  const persisted = registry.bindings?.[bindingId]

  // Positive controls: a broken socket, unfinished daemon hello, or wrong
  // registry path cannot masquerade as the missing behavior below.
  assert.equal(persisted?.bindingId, bindingId, 'the real wire persisted the binding id')
  assert.equal(persisted?.project, project, 'the real wire persisted the project')
  assert.equal(
    persisted?.daemonKey,
    'git-backed-machine:test',
    'the real wire attributed the binding to the connected daemon',
  )

  // First required production boundary. Once this passes, this same harness
  // can proceed to the finite adversarial scheduler: interleave filesystem and
  // Git edits, stale accepts, materialization RPCs, source-room edits, and
  // reconciliation until quiescence; then compare the accepted revision, each
  // materialized checkout, the Git remote, and every source-room/rendered copy.
  // Today there is no honest participant to schedule because these fields are
  // discarded by both ends of the production binding path.
  assert.equal(
    persisted?.kind,
    'git',
    'MISSING PRODUCTION BEHAVIOR: source binding registration discards the Git-backed daemon kind',
  )
  assert.equal(
    persisted?.remote,
    remote,
    'MISSING PRODUCTION BEHAVIOR: source binding registration discards the Git remote',
  )
  assert.equal(
    persisted?.mirrorMode,
    'auto-merge',
    'MISSING PRODUCTION BEHAVIOR: source binding registration discards the daemon mirror mode',
  )

  console.log('sync convergence state machine: Git-backed daemon boundary is available')
} catch (error) {
  if (server) error.message += `\nserver log:\n${server.output()}`
  throw error
} finally {
  await targetSync?.closeAll()
  ws?.terminate()
  peerWs?.terminate()
  targetWs?.terminate()
  await stopServer(server)
  await closeProjectStore()
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}
