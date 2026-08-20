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
import Database from 'better-sqlite3'

import {
  closeProjectStore,
  createProject,
  initProjectStore,
  sourceLifecycleStore,
  updateClientSourceManifest,
  updateProject,
} from '../server/lib/project-store.mjs'
import { createSourceSync } from '../daemon/source-sync.mjs'
import { createGitSourceManager } from '../daemon/git-source.mjs'
import { DaemonDeliveryRuntime } from '../daemon/delivery-runtime.mjs'
import { DaemonOutbox } from '../daemon/outbox.mjs'
import { createShadowMirror } from '../daemon/shadow-mirror.mjs'
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
const trace = label => { if (process.env.TLDA_SYNC_TRACE) process.stderr.write(`${label}\n`) }
const deliverBounded = (socket, envelope, timeoutMs = 120_000) => new Promise((resolve, reject) => {
  const received = []
  const onMessage = raw => {
    const message = JSON.parse(String(raw))
    received.push(message)
    if (message.type !== 'daemon-outbox-ack' || message.outbox_id !== envelope.__daemon_outbox_id) return
    clearTimeout(timeout)
    socket.off('message', onMessage)
    resolve(received)
  }
  const timeout = setTimeout(() => {
    socket.off('message', onMessage)
    reject(new Error(`delivery timed out after ${timeoutMs}ms: ${JSON.stringify(received)}`))
  }, timeoutMs)
  socket.on('message', onMessage)
  socket.send(JSON.stringify(envelope))
})
let server
let ws
let peerWs
let targetWs
let targetSync
let durableDelivery
let durableOutbox
let gitSync
let gitSources

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

  // The production durable sender, including one forced reconnect. The row is
  // inserted before its first send, survives the socket replacement, replays
  // under the same delivery id, receives the canonical result and ACK, and is
  // then cleared by the real delivery runtime.
  const durableId = 'D-durable-reconnect'
  const durableRequestId = 'R-durable-reconnect'
  durableOutbox = new DaemonOutbox(join(root, 'writer-one-outbox.sqlite'))
  let durableWs = ws
  const durableMessages = []
  const attachDurableReceiver = socket => socket.on('message', raw => {
    const message = JSON.parse(String(raw))
    durableMessages.push(message)
    if (message.type === 'daemon-outbox-ack') durableDelivery.handleAck(message.outbox_id)
    if (message.type === 'daemon-outbox-error') {
      durableDelivery.handleError(message.outbox_id, message.error, { permanent: message.permanent === true })
    }
  })
  durableDelivery = new DaemonDeliveryRuntime({
    inflightDeadlineMs: 120_000,
    flushByteBudget: 1_048_576,
    outbox: durableOutbox,
    send(message) { durableWs.send(JSON.stringify(message)); return true },
    isConnected: () => durableWs?.readyState === 1,
    isReady: () => durableWs?.readyState === 1,
  })
  attachDurableReceiver(durableWs)
  durableDelivery.send({
    type: 'source-change', project, requestId: durableRequestId,
    expectedRevision: bootstrap.authority.currentRevision,
    sourceBindingId: 'writer-one-binding',
    files: [
      { path: 'main.tex', content: 'revision-0:main\n' },
      { path: 'part.tex', content: 'revision-0:part\n' },
    ],
    deletedFiles: [], sourceManifest: ['main.tex', 'part.tex'],
    editedBy: 'writer-one', __daemon_outbox_id: durableId,
  })
  const firstSendDeadline = Date.now() + 20_000
  while ((durableOutbox.get(durableId)?.attempts || 0) < 1 && Date.now() < firstSendDeadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(durableOutbox.get(durableId)?.attempts, 1, 'durable row was not offered before reconnect')
  durableWs.terminate()
  durableWs = await openDaemon(port, {
    machineId: 'writer-one-machine',
    sourceBindings: [{ bindingId: 'writer-one-binding', project }],
    onRpc: async message => message.op === 'mirror-shadow-ref'
      ? ({ ok: true, project })
      : ({ ok: false, reason: 'project-not-watched' }),
  })
  ws = durableWs
  attachDurableReceiver(durableWs)
  durableDelivery.noteReady()
  const durableWaitStarted = Date.now()
  const durableDeadline = durableWaitStarted + 120_000
  const durableLedger = new Database(fleetDb, { readonly: true })
  const durableState = () => ({
    result: durableMessages.find(message => message.type === 'source-change-result' && message.deliveryId === durableId),
    ack: durableMessages.some(message => message.type === 'daemon-outbox-ack' && message.outbox_id === durableId),
    processed: durableLedger.prepare('SELECT id, type FROM daemon_outbox_processed WHERE id = ?').get(durableId),
    outbox: durableOutbox.get(durableId),
  })
  let durableSnapshot = durableState()
  const durableSendAttempts = 1
  while (!(durableSnapshot.result?.ok && durableSnapshot.ack && durableSnapshot.processed && !durableSnapshot.outbox) && Date.now() < durableDeadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
    durableSnapshot = durableState()
  }
  const durableElapsedMs = Date.now() - durableWaitStarted
  const durableResult = durableSnapshot.result
  if (process.env.TLDA_SYNC_SINGLE_TRANSITION) {
    const diagnostic = {
      elapsedMs: durableElapsedMs,
      outbox: durableSnapshot.outbox,
      sendAttempts: durableSendAttempts,
      reconnectAttempts: 1,
      socketReadyState: durableWs?.readyState ?? null,
      processed: durableSnapshot.processed,
      canonicalResult: durableSnapshot.result ?? null,
      ack: durableSnapshot.ack,
      localClearance: !durableSnapshot.outbox,
    }
    console.log(`sync convergence state machine: single durable transition ${JSON.stringify(diagnostic)}`)
    if (!(durableResult?.ok && durableSnapshot.ack && durableSnapshot.processed && !durableSnapshot.outbox)) {
      throw new Error(`single durable transition first missing state: ${JSON.stringify(diagnostic)}`)
    }
  }
  assert.equal(durableResult?.ok, true, `elapsed=${durableElapsedMs}ms state=${JSON.stringify(durableSnapshot)} messages=${JSON.stringify(durableMessages)}`)
  assert.equal(durableSnapshot.ack, true, `elapsed=${durableElapsedMs}ms state=${JSON.stringify(durableSnapshot)}`)
  try {
    assert.deepEqual(
      durableSnapshot.processed,
      { id: durableId, type: 'source-change' },
      'server processed ledger did not retain the replayed durable delivery id',
    )
  } finally {
    durableLedger.close()
  }

  let acceptedRevision = durableResult.sourceRevision
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
      const staleMessages = await deliverBounded(writer.ws, {
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

    const acceptedMessages = await deliverBounded(writer.ws, {
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
  trace('git:seed')

  // A real Git edge now takes the same path to the fixed point. Seed the
  // collaborator remote from the accepted server bytes, create a conflicting
  // local/remote pair, resolve it in the watched working copy, and let the
  // ordinary source watcher submit that resolution. The server's accepted Git
  // commit is mirrored back through the daemon RPC and that exact commit is
  // what publishAccepted pushes to the remote.
  const seed = join(root, 'git-seed')
  execFileSync('git', ['clone', '--quiet', remote, seed])
  execFileSync('git', ['switch', '-c', 'main'], { cwd: seed })
  execFileSync('git', ['config', 'user.name', 'fixture'], { cwd: seed })
  execFileSync('git', ['config', 'user.email', 'fixture@example.test'], { cwd: seed })
  writeFileSync(join(seed, 'main.tex'), `revision-${acceptedOrdinal}:main\n`)
  writeFileSync(join(seed, 'part.tex'), `revision-${acceptedOrdinal}:part\n`)
  execFileSync('git', ['add', 'main.tex', 'part.tex'], { cwd: seed })
  execFileSync('git', ['commit', '--quiet', '-m', 'Seed accepted source'], { cwd: seed })
  execFileSync('git', ['push', '--quiet', '-u', 'origin', 'main'], { cwd: seed })
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: remote })

  const gitWatcher = new EventEmitter()
  gitWatcher.close = () => Promise.resolve()
  const gitResults = []
  gitSync = createSourceSync({
    sourceChangeSettleDeadlineMs: 300_000,
    sourceBindingsFile: join(root, 'git-bindings.json'),
    log: { info() {}, warn() {}, error() {} },
    sendMsg(message) { ws.send(JSON.stringify(message)); return true },
    isConnected: () => ws?.readyState === 1,
    resolveEditor: () => null,
    reconcileIntervalMs: 60_000,
    watch() { return gitWatcher },
  })
  gitSources = createGitSourceManager({
    stateFile: join(root, 'git-sources.json'),
    sourcesRoot: join(root, 'git-sources'),
    queuePaths: (name, paths) => gitSync.queuePaths(name, paths),
    log: { info() {}, warn() {}, error() {} },
  })
  const linked = await gitSources.link({ project, remote, mirrorMode: 'auto-merge', pollSeconds: 3600 })
  trace('git:linked')
  const gitBinding = gitSync.bindSource(project, linked.sourceDir, registration)
  gitSync.sync([{
    name: project,
    sourceDir: linked.sourceDir,
    mainFile: 'main.tex',
    format: 'svg',
    sourceRevision: acceptedRevision,
    sourceManifest: ['main.tex', 'part.tex'],
  }], { authoritativeRevisions: true })
  const shadowMirror = createShadowMirror({
    getSourceDir: () => linked.sourceDir,
    log: { info() {}, warn() {}, error() {} },
    afterMirror: update => gitSources.publishAccepted(update),
  })
  ws.terminate()
  ws = await openDaemon(port, {
    machineId: 'git-backed-machine',
    sourceBindings: [{ ...registration, bindingId: gitBinding.bindingId }],
    onRpc: message => message.op === 'mirror-shadow-ref'
      ? shadowMirror.mirrorShadowRef(message)
      : message.op === 'apply-source-update'
        ? gitSync.applyAcceptedSourceUpdate(message)
        : ({ ok: false, reason: 'project-not-watched' }),
  })
  ws.on('message', raw => {
    const message = JSON.parse(String(raw))
    if (message.type === 'source-change-result') {
      gitResults.push(message)
      gitSync.handleSourceChangeResult(message)
    }
  })
  trace('git:connected')

  writeFileSync(join(linked.sourceDir, 'main.tex'), 'local-conflict:main\n')
  execFileSync('git', ['add', 'main.tex'], { cwd: linked.sourceDir })
  execFileSync('git', ['commit', '--quiet', '-m', 'Local conflicting edit'], { cwd: linked.sourceDir })
  execFileSync('git', ['update-ref', 'refs/tlda/shadow/HEAD', 'HEAD'], { cwd: linked.sourceDir })
  const collaborator = join(root, 'git-collaborator')
  execFileSync('git', ['clone', '--quiet', remote, collaborator])
  execFileSync('git', ['config', 'user.name', 'collaborator'], { cwd: collaborator })
  execFileSync('git', ['config', 'user.email', 'collaborator@example.test'], { cwd: collaborator })
  writeFileSync(join(collaborator, 'main.tex'), 'remote-conflict:main\n')
  execFileSync('git', ['add', 'main.tex'], { cwd: collaborator })
  execFileSync('git', ['commit', '--quiet', '-m', 'Remote conflicting edit'], { cwd: collaborator })
  execFileSync('git', ['push', '--quiet'], { cwd: collaborator })

  const conflicted = await gitSources.poll(project)
  trace(`git:poll:${conflicted.status}`)
  assert.equal(conflicted.status, 'conflicted', JSON.stringify(conflicted))
  assert.deepEqual(conflicted.conflicted, ['main.tex'])
  assert.match(readFileSync(join(linked.sourceDir, 'main.tex'), 'utf8'), /^<<<<<<< /)

  const resolvedMain = 'resolved-fixed-point:main\n'
  const resolvedPart = 'resolved-fixed-point:part\n'
  writeFileSync(join(linked.sourceDir, 'main.tex'), resolvedMain)
  writeFileSync(join(linked.sourceDir, 'part.tex'), resolvedPart)
  execFileSync('git', ['add', 'main.tex', 'part.tex'], { cwd: linked.sourceDir })
  gitSync.queuePaths(project, ['main.tex', 'part.tex'])
  trace('git:resolution-queued')

  const gitDeadline = Date.now() + 30_000
  let remoteHead = ''
  while (Date.now() < gitDeadline) {
    const accepted = [...gitResults].reverse().find(message => message.ok)
    try {
      remoteHead = execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: remote, encoding: 'utf8' }).trim()
    } catch {
      // Remote ref may not exist until the accepted mirror is published.
    }
    if (accepted?.sourceRevision && remoteHead === accepted.sourceRevision) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const gitAccepted = [...gitResults].reverse().find(message => message.ok)
  trace(`git:accepted:${gitAccepted?.sourceRevision || 'none'} remote:${remoteHead || 'none'}`)
  assert.ok(gitAccepted?.sourceRevision, JSON.stringify(gitResults))
  assert.equal(remoteHead, gitAccepted.sourceRevision, 'remote was not pushed to the exact accepted revision')
  assert.equal(readFileSync(join(projectsDir, project, 'source', 'main.tex'), 'utf8'), resolvedMain)
  assert.equal(readFileSync(join(projectsDir, project, 'source', 'part.tex'), 'utf8'), resolvedPart)
  assert.equal(readFileSync(join(linked.sourceDir, 'main.tex'), 'utf8'), resolvedMain)
  assert.equal(readFileSync(join(linked.sourceDir, 'part.tex'), 'utf8'), resolvedPart)
  assert.equal(execFileSync('git', ['show', `${remoteHead}:main.tex`], { cwd: remote, encoding: 'utf8' }), resolvedMain)
  assert.equal(execFileSync('git', ['show', `${remoteHead}:part.tex`], { cwd: remote, encoding: 'utf8' }), resolvedPart)

  console.log('sync convergence state machine: Git conflict resolution reached an exact all-surface fixed point')
} catch (error) {
  if (server) error.message += `\nserver log:\n${server.output()}`
  throw error
} finally {
  durableDelivery?.dispose()
  durableOutbox?.close()
  gitSources?.close()
  await gitSync?.closeAll()
  await targetSync?.closeAll()
  ws?.terminate()
  peerWs?.terminate()
  targetWs?.terminate()
  await stopServer(server)
  await closeProjectStore()
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}
