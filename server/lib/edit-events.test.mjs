import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import express from 'express'

import { initProjectStore, closeProjectStore, createProject, sourceLifecycleStore } from './project-store.mjs'
import historyRoutes from '../routes/history.mjs'
import {
  appendAgentAction,
  finalizeEditEventsForSourceRevision,
  readEditEvents,
  recordAcceptedSourceTransaction,
} from './edit-events.mjs'

async function withProject(fn) {
  const root = mkdtempSync(join(tmpdir(), 'tlda-edit-events-'))
  await initProjectStore(root)
  try {
    createProject({ name: 'paper', title: 'paper' })
    await fn('paper')
  } finally {
    await closeProjectStore()
    rmSync(root, { recursive: true, force: true })
  }
}

async function bootstrap(name, content = 'one\n') {
  const lifecycle = await sourceLifecycleStore(name)
  const result = lifecycle.bootstrap({
    expectedRevision: null,
    files: [{ path: 'main.tex', content }],
    sourceManifest: ['main.tex'],
  })
  assert.equal(result.ok, true)
  return result.authority.currentRevision
}

async function bootstrapFiles(name, files) {
  const lifecycle = await sourceLifecycleStore(name)
  const result = lifecycle.bootstrap({
    expectedRevision: null,
    files,
    sourceManifest: files.map(file => file.path),
  })
  assert.equal(result.ok, true)
  return result.authority.currentRevision
}

async function submit(name, expectedRevision, content) {
  const lifecycle = await sourceLifecycleStore(name)
  const result = lifecycle.submit({
    expectedRevision,
    files: [{ path: 'main.tex', content }],
    sourceManifest: ['main.tex'],
  })
  assert.equal(result.ok, true)
  return result.authority.currentRevision
}

async function submitFiles(name, expectedRevision, files) {
  const lifecycle = await sourceLifecycleStore(name)
  const result = lifecycle.submit({
    expectedRevision,
    files,
    sourceManifest: files.map(file => file.path),
  })
  assert.equal(result.ok, true)
  return result.authority.currentRevision
}

test('browser source transaction records a direct yjs edit event and finalizes shadow/page fields', async () => {
  await withProject(async name => {
    const before = await bootstrap(name)
    const after = await submit(name, before, 'one\ntwo\n')

    await recordAcceptedSourceTransaction(name, {
      requestId: 'browser-1',
      editedBy: 'skip',
    }, {
      previousRevision: before,
      sourceRevision: after,
      files: [{ path: 'main.tex' }],
      deletedFiles: [],
      sourceManifest: ['main.tex'],
    })
    await finalizeEditEventsForSourceRevision(name, { sourceRevision: after, shadowRevision: 'shadow-abc' })

    const payload = await readEditEvents(name)
    assert.equal(payload.events.length, 1)
    assert.equal(payload.events[0].origin, 'yjs')
    assert.equal(payload.events[0].actor_kind, 'human')
    assert.equal(payload.events[0].actor_id, 'skip')
    assert.equal(payload.events[0].attribution_status, 'direct')
    assert.equal(payload.events[0].after_shadow_revision, 'shadow-abc')
  })
})

test('daemon transaction reconciles a delayed agent action and leaves residual daemon/manual edit', async () => {
  await withProject(async name => {
    const before = await bootstrapFiles(name, [
      { path: 'main.tex', content: 'alpha\n' },
      { path: 'notes.tex', content: 'manual\n' },
    ])
    const after = await submitFiles(name, before, [
      { path: 'main.tex', content: 'alpha agent\n' },
      { path: 'notes.tex', content: 'manual human\n' },
    ])

    await recordAcceptedSourceTransaction(name, {
      requestId: 'daemon-1',
      sourceDaemonKey: 'mini:testing',
      sourceMachineId: 'mini',
      sourceEnvName: 'testing',
    }, {
      previousRevision: before,
      sourceRevision: after,
      files: [{ path: 'main.tex' }, { path: 'notes.tex' }],
      deletedFiles: [],
      sourceManifest: ['main.tex', 'notes.tex'],
    })

    let payload = await readEditEvents(name, { include_pending: true })
    assert.equal(payload.pending_count, 1)
    assert.equal(payload.events.length, 0)

    await appendAgentAction(name, {
      daemon_key: 'mini:testing',
      agent_id: 'fleet:agent-a',
      agent_display_name: 'agent-a',
      tool_use_id: 'tool-a',
      files: [{ path: 'main.tex', content_delta: 'alpha agent' }],
    })

    payload = await readEditEvents(name)
    assert.equal(payload.events.length, 2)
    const agent = payload.events.find(event => event.actor_kind === 'agent')
    const residual = payload.events.find(event => event.manual_residual)
    assert.equal(agent.actor_id, 'fleet:agent-a')
    assert.equal(agent.attribution_status, 'derived')
    assert.equal(residual.actor_kind, 'daemon')
    assert.equal(residual.attribution_status, 'inferred')
    assert.equal(payload.pending_count, 0)
  })
})

test('daemon reconciliation records non-unique patch decomposition as ambiguous, not recency attributed', async () => {
  await withProject(async name => {
    const before = await bootstrap(name, 'same\n')
    await appendAgentAction(name, {
      daemon_key: 'mini:testing',
      agent_id: 'fleet:agent-a',
      tool_use_id: 'tool-a',
      files: [{ path: 'main.tex', content_delta: 'same changed' }],
    })
    await appendAgentAction(name, {
      daemon_key: 'mini:testing',
      agent_id: 'fleet:agent-b',
      tool_use_id: 'tool-b',
      files: [{ path: 'main.tex', content_delta: 'same changed' }],
    })
    const after = await submit(name, before, 'same changed\n')
    await recordAcceptedSourceTransaction(name, {
      requestId: 'daemon-ambiguous',
      sourceDaemonKey: 'mini:testing',
    }, {
      previousRevision: before,
      sourceRevision: after,
      files: [{ path: 'main.tex' }],
      deletedFiles: [],
      sourceManifest: ['main.tex'],
    })

    const payload = await readEditEvents(name)
    assert.equal(payload.events.length, 1)
    assert.equal(payload.events[0].ambiguous, true)
    assert.equal(payload.events[0].attribution_basis.rule, 'daemon-ambiguous-patch-decomposition')
    assert.deepEqual(payload.events[0].attribution_basis.candidate_agent_action_ids.length, 2)
  })
})

test('overleaf transaction uses git author as actor and keeps committer as basis metadata', async () => {
  await withProject(async name => {
    const before = await bootstrap(name)
    const after = await submit(name, before, 'remote edit\n')
    await recordAcceptedSourceTransaction(name, {
      requestId: 'overleaf-1',
      overleafSync: true,
      overleafRemote: '/tmp/remote.git',
      overleafCommits: [{
        hash: 'abc123',
        author: { name: 'Author A', email: 'a@example.test' },
        committer: { name: 'Bridge', email: 'bridge@example.test' },
        changed_paths: ['main.tex'],
        deleted_paths: [],
      }],
    }, {
      previousRevision: before,
      sourceRevision: after,
      files: [{ path: 'main.tex' }],
      deletedFiles: [],
      sourceManifest: ['main.tex'],
    })

    const payload = await readEditEvents(name)
    assert.equal(payload.events.length, 1)
    assert.equal(payload.events[0].origin, 'overleaf')
    assert.equal(payload.events[0].actor_id, 'git:a@example.test')
    assert.equal(payload.events[0].attribution_basis.committer.email, 'bridge@example.test')
  })
})

test('history edit-events endpoint returns canonical events and actor facets', async () => {
  await withProject(async name => {
    const before = await bootstrap(name)
    const after = await submit(name, before, 'api edit\n')
    await recordAcceptedSourceTransaction(name, {
      requestId: 'api-1',
      editedBy: 'skip',
    }, {
      previousRevision: before,
      sourceRevision: after,
      files: [{ path: 'main.tex' }],
      deletedFiles: [],
      sourceManifest: ['main.tex'],
    })

    const app = express()
    app.use(express.json())
    app.use('/api/projects/:name/history', historyRoutes)
    const server = app.listen(0, '127.0.0.1')
    try {
      await new Promise(resolve => server.once('listening', resolve))
      const { port } = server.address()
      const res = await fetch(`http://127.0.0.1:${port}/api/projects/${name}/history/edit-events`)
      assert.equal(res.status, 200)
      const payload = await res.json()
      assert.equal(payload.project, name)
      assert.equal(payload.events.length, 1)
      assert.equal(payload.events[0].event_id.startsWith('edit-'), true)
      assert.equal(payload.actors[0].display_name, 'skip')
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })
})
