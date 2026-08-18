#!/usr/bin/env node
import assert from 'assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  closeProjectStore,
  createProject,
  initProjectStore,
  outputDir,
  sourceLifecycleStore,
  updateProject,
} from '../server/lib/project-store.mjs'
import { push } from './lib/lifecycle-push-test-helper.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-two-participant-source-'))
await initProjectStore(root)

function suppressBuilds(name) {
  mkdirSync(outputDir(name), { recursive: true })
  writeFileSync(join(outputDir(name), 'relevant-files.json'), JSON.stringify({ files: ['not-this-test.tex'] }))
}

try {
  createProject({ name: 'two-participant-source', title: 'Two participant source', mainFile: 'main.tex', format: 'svg' })
  await updateProject('two-participant-source', { pages: 1, buildStatus: 'success' })
  suppressBuilds('two-participant-source')
  const lifecycle = await sourceLifecycleStore('two-participant-source')

  const base = await push(lifecycle, {
    expectedRevision: null,
    sourceManifest: ['main.tex', 'notes.tex'],
    changed: [
      { path: 'main.tex', content: 'base main\n' },
      { path: 'notes.tex', content: 'base notes\n' },
    ],
  })
  assert.equal(base.ok, true)
  assert.equal(base.status, 'accepted')

  const alice = await push(lifecycle, {
    expectedRevision: base.revision.id,
    sourceManifest: ['main.tex', 'notes.tex'],
    changed: [{ path: 'main.tex', content: 'alice main\n' }],
  })
  assert.equal(alice.ok, true)

  // Bob pushes against the same (now-stale) base as alice, touching a
  // disjoint file. The mechanism's promise: independent edits converge
  // rather than one clobbering the other.
  const bob = await push(lifecycle, {
    expectedRevision: base.revision.id,
    sourceManifest: ['main.tex', 'notes.tex'],
    changed: [{ path: 'notes.tex', content: 'bob notes\n' }],
  })
  assert.equal(bob.ok, true, bob.evidence ? JSON.stringify(bob.evidence) : undefined)
  assert.equal(bob.status, 'accepted-clean-rebase')
  assert.equal((await lifecycle.snapshotFile(bob.revision, 'main.tex')).toString(), 'alice main\n')
  assert.equal((await lifecycle.snapshotFile(bob.revision, 'notes.tex')).toString(), 'bob notes\n')
  assert.equal((await lifecycle.readAuthority()).currentRevision, bob.revision.id)

  createProject({ name: 'two-participant-conflict', title: 'Two participant conflict', mainFile: 'main.tex', format: 'svg' })
  await updateProject('two-participant-conflict', { pages: 1, buildStatus: 'success' })
  suppressBuilds('two-participant-conflict')
  const conflictLifecycle = await sourceLifecycleStore('two-participant-conflict')

  const conflictBase = await push(conflictLifecycle, {
    expectedRevision: null,
    sourceManifest: ['main.tex'],
    changed: [{ path: 'main.tex', content: 'base\n' }],
  })
  assert.equal(conflictBase.ok, true)
  const conflictAlice = await push(conflictLifecycle, {
    expectedRevision: conflictBase.revision.id,
    sourceManifest: ['main.tex'],
    changed: [{ path: 'main.tex', content: 'alice\n' }],
  })
  assert.equal(conflictAlice.ok, true)

  // Bob pushes against the same stale base, touching the SAME file alice
  // already moved. There is no clean rebase for this -- the mechanism must
  // refuse rather than silently pick a winner, and name the conflict.
  const conflictBob = await push(conflictLifecycle, {
    expectedRevision: conflictBase.revision.id,
    sourceManifest: ['main.tex'],
    changed: [{ path: 'main.tex', content: 'bob\n' }],
  })
  assert.equal(conflictBob.ok, false)
  assert.equal(conflictBob.status, 'stale-base')
  assert.equal(conflictBob.evidence.classifications[0].status, 'conflict')
  assert.equal((await conflictLifecycle.snapshotFile(conflictAlice.revision, 'main.tex')).toString(), 'alice\n')

  console.log('two participant source convergence tests passed')
} finally {
  await closeProjectStore()
}
