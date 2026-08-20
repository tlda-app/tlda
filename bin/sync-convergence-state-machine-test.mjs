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
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  closeProjectStore,
  createProject,
  initProjectStore,
  updateProject,
} from '../server/lib/project-store.mjs'
import {
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

try {
  execFileSync('git', ['init', '--bare', '--quiet', remote])

  await initProjectStore(projectsDir)
  createProject({ name: project, mainFile: 'main.tex', format: 'svg' })
  await updateProject(project, { pages: 1, buildStatus: 'success' })
  mkdirSync(join(projectsDir, project, 'output'), { recursive: true })
  await closeProjectStore()

  server = await startServer({ port, projectsDir, fleetDb, bindingRegistry })
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
} finally {
  ws?.terminate()
  await stopServer(server)
  await closeProjectStore()
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}
