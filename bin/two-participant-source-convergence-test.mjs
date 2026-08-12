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
  readSourceFile,
  sourceLifecycleStore,
  updateProject,
} from '../server/lib/project-store.mjs'
import { processProjectPush } from '../server/routes/projects.mjs'

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

  const base = await processProjectPush('two-participant-source', {
    expectedRevision: null,
    sourceManifest: ['main.tex', 'notes.tex'],
    files: [
      { path: 'main.tex', content: 'base main\n' },
      { path: 'notes.tex', content: 'base notes\n' },
    ],
  })
  assert.equal(base.status, 200)

  const alice = await processProjectPush('two-participant-source', {
    expectedRevision: base.sourceRevision,
    sourceManifest: ['main.tex', 'notes.tex'],
    files: [{ path: 'main.tex', content: 'alice main\n' }],
  })
  assert.equal(alice.status, 200)

  const bob = await processProjectPush('two-participant-source', {
    expectedRevision: base.sourceRevision,
    sourceManifest: ['main.tex', 'notes.tex'],
    files: [{ path: 'notes.tex', content: 'bob notes\n' }],
  })
  assert.equal(bob.status, 200, bob.error)
  assert.equal(readSourceFile('two-participant-source', 'main.tex'), 'alice main\n')
  assert.equal(readSourceFile('two-participant-source', 'notes.tex'), 'bob notes\n')
  assert.equal((await sourceLifecycleStore('two-participant-source')).readAuthority().currentRevision, bob.sourceRevision)

  createProject({ name: 'two-participant-conflict', title: 'Two participant conflict', mainFile: 'main.tex', format: 'svg' })
  await updateProject('two-participant-conflict', { pages: 1, buildStatus: 'success' })
  suppressBuilds('two-participant-conflict')

  const conflictBase = await processProjectPush('two-participant-conflict', {
    expectedRevision: null,
    sourceManifest: ['main.tex'],
    files: [{ path: 'main.tex', content: 'base\n' }],
  })
  assert.equal(conflictBase.status, 200)
  const conflictAlice = await processProjectPush('two-participant-conflict', {
    expectedRevision: conflictBase.sourceRevision,
    sourceManifest: ['main.tex'],
    files: [{ path: 'main.tex', content: 'alice\n' }],
  })
  assert.equal(conflictAlice.status, 200)
  const conflictBob = await processProjectPush('two-participant-conflict', {
    expectedRevision: conflictBase.sourceRevision,
    sourceManifest: ['main.tex'],
    files: [{ path: 'main.tex', content: 'bob\n' }],
  })
  assert.equal(conflictBob.status, 409)
  assert.equal(conflictBob.lifecycleStatus, 'stale-base')
  assert.equal(conflictBob.evidence.classifications[0].status, 'conflict')
  assert.equal(readSourceFile('two-participant-conflict', 'main.tex'), 'alice\n')

  console.log('two participant source convergence tests passed')
} finally {
  await closeProjectStore()
}
