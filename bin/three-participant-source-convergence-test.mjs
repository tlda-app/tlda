#!/usr/bin/env node
// Three participants on one project's source, from the incidents that happened.
//
// The two-participant case is bin/two-participant-source-convergence-test.mjs,
// fixed by c730ef058 "Accept clean source rebases". Adding a third participant
// is not more of the same: the third one rebases against a current revision
// that is ITSELF a rebase, so the merge base it was handed is two revisions
// behind. That is the case that loses an edit silently if the chain breaks.
//
// Every assertion here is about bytes on disk and the authority's current
// revision, not about what a function returned.
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

const root = mkdtempSync(join(tmpdir(), 'tlda-three-participant-source-'))
await initProjectStore(root)

function suppressBuilds(name) {
  mkdirSync(outputDir(name), { recursive: true })
  writeFileSync(join(outputDir(name), 'relevant-files.json'), JSON.stringify({ files: ['not-this-test.tex'] }))
}

async function newProject(name) {
  createProject({ name, title: name, mainFile: 'main.tex', format: 'svg' })
  await updateProject(name, { pages: 1, buildStatus: 'success' })
  suppressBuilds(name)
}

const MANIFEST = ['main.tex', 'notes.tex', 'refs.tex']

async function seed(name) {
  const base = await processProjectPush(name, {
    expectedRevision: null,
    sourceManifest: MANIFEST,
    files: [
      { path: 'main.tex', content: 'base main\n' },
      { path: 'notes.tex', content: 'base notes\n' },
      { path: 'refs.tex', content: 'base refs\n' },
    ],
  })
  assert.equal(base.status, 200, base.error)
  return base.sourceRevision
}

try {
  // Story one: three participants, three different files, all holding the same
  // base revision. Nobody is told to reload; every edit has to land.
  await newProject('three-participant-source')
  const base = await seed('three-participant-source')

  const alice = await processProjectPush('three-participant-source', {
    expectedRevision: base,
    sourceManifest: MANIFEST,
    files: [{ path: 'main.tex', content: 'alice main\n' }],
  })
  assert.equal(alice.status, 200, alice.error)

  const bob = await processProjectPush('three-participant-source', {
    expectedRevision: base,
    sourceManifest: MANIFEST,
    files: [{ path: 'notes.tex', content: 'bob notes\n' }],
  })
  assert.equal(bob.status, 200, bob.error)

  // Carol is the new case. Her expectedRevision is the original base, but the
  // authority has moved twice since — and the second move was a rebase, not a
  // plain accept. She must merge against both.
  const carol = await processProjectPush('three-participant-source', {
    expectedRevision: base,
    sourceManifest: MANIFEST,
    files: [{ path: 'refs.tex', content: 'carol refs\n' }],
  })
  assert.equal(carol.status, 200, carol.error)

  assert.equal(readSourceFile('three-participant-source', 'main.tex'), 'alice main\n')
  assert.equal(readSourceFile('three-participant-source', 'notes.tex'), 'bob notes\n')
  assert.equal(readSourceFile('three-participant-source', 'refs.tex'), 'carol refs\n')

  const authority = (await sourceLifecycleStore('three-participant-source')).readAuthority()
  assert.equal(authority.state, 'current')
  assert.equal(authority.currentRevision, carol.sourceRevision)

  // The stored revision is the whole snapshot, not just the last file pushed.
  // A revision that carried only Carol's file would read as convergent on disk
  // today and lose Alice and Bob on the next rebase against it.
  const carolRevision = (await sourceLifecycleStore('three-participant-source')).readRevision(carol.sourceRevision)
  const stored = new Map(carolRevision.files.map(file => [file.path, Buffer.from(file.content, 'base64').toString()]))
  assert.deepEqual([...stored.keys()].sort(), MANIFEST)
  assert.equal(stored.get('main.tex'), 'alice main\n')
  assert.equal(stored.get('notes.tex'), 'bob notes\n')
  assert.equal(stored.get('refs.tex'), 'carol refs\n')

  // Story two: the third participant collides. Alice and Bob land disjointly;
  // Carol edits the same region of the file Alice already changed. The push
  // must be refused — and, because the route writes pushed files to disk
  // BEFORE the lifecycle adjudicates, the refusal must leave nothing of
  // Carol's behind. A rejected push that still overwrote the file is exactly
  // the silent-destructive case.
  await newProject('three-participant-collision')
  const collisionBase = await seed('three-participant-collision')

  const cAlice = await processProjectPush('three-participant-collision', {
    expectedRevision: collisionBase,
    sourceManifest: MANIFEST,
    files: [{ path: 'main.tex', content: 'alice main\n' }],
  })
  assert.equal(cAlice.status, 200, cAlice.error)

  const cBob = await processProjectPush('three-participant-collision', {
    expectedRevision: collisionBase,
    sourceManifest: MANIFEST,
    files: [{ path: 'notes.tex', content: 'bob notes\n' }],
  })
  assert.equal(cBob.status, 200, cBob.error)

  const cCarol = await processProjectPush('three-participant-collision', {
    expectedRevision: collisionBase,
    sourceManifest: MANIFEST,
    files: [{ path: 'main.tex', content: 'carol main\n' }],
  })
  assert.equal(cCarol.status, 409)
  assert.equal(cCarol.lifecycleStatus, 'stale-base')

  assert.equal(readSourceFile('three-participant-collision', 'main.tex'), 'alice main\n')
  assert.equal(readSourceFile('three-participant-collision', 'notes.tex'), 'bob notes\n')
  assert.equal(readSourceFile('three-participant-collision', 'refs.tex'), 'base refs\n')
  assert.equal(
    (await sourceLifecycleStore('three-participant-collision')).readAuthority().currentRevision,
    cBob.sourceRevision,
  )

  // The evidence names the file that actually collided, and only that one.
  // Bob's file rebased cleanly inside the same submission and must not be
  // reported as conflicted — a conflict marker dropped into a file nobody
  // edited is how a good file gets destroyed by a rejection.
  const classifications = cCarol.evidence.classifications
  const conflicted = classifications.filter(item => item.status === 'conflict').map(item => item.path)
  assert.deepEqual(conflicted, ['main.tex'])

  // Story three: two participants collide on one file while a third lands a
  // disjoint edit in the same window. The disjoint edit is the one at risk —
  // it must not be rolled back by somebody else's conflict.
  await newProject('three-participant-bystander')
  const bystanderBase = await seed('three-participant-bystander')

  const bAlice = await processProjectPush('three-participant-bystander', {
    expectedRevision: bystanderBase,
    sourceManifest: MANIFEST,
    files: [{ path: 'main.tex', content: 'alice main\n' }],
  })
  assert.equal(bAlice.status, 200, bAlice.error)

  const bCarol = await processProjectPush('three-participant-bystander', {
    expectedRevision: bystanderBase,
    sourceManifest: MANIFEST,
    files: [{ path: 'main.tex', content: 'carol main\n' }],
  })
  assert.equal(bCarol.status, 409)

  const bBob = await processProjectPush('three-participant-bystander', {
    expectedRevision: bystanderBase,
    sourceManifest: MANIFEST,
    files: [{ path: 'notes.tex', content: 'bob notes\n' }],
  })
  assert.equal(bBob.status, 200, bBob.error)

  assert.equal(readSourceFile('three-participant-bystander', 'main.tex'), 'alice main\n')
  assert.equal(readSourceFile('three-participant-bystander', 'notes.tex'), 'bob notes\n')
  assert.equal(
    (await sourceLifecycleStore('three-participant-bystander')).readAuthority().currentRevision,
    bBob.sourceRevision,
  )

  console.log('three participant source convergence tests passed')
} finally {
  await closeProjectStore()
}
