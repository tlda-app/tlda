#!/usr/bin/env node
// What a push has to copy before the server will judge it.
//
// Every push takes a rollback snapshot first. That snapshot used to include the
// whole of `.source-lifecycle`, which is the project's entire revision history —
// and a revision carries its files' content, so the history is a multiple of the
// source tree and grows by one tree per accepted push.
//
// On `bregman` on 2026-08-18 that copy was 14 GB against a 33 MB source tree,
// taken before `lifecycle.submit` had decided anything, and again in reverse on
// rollback. The daemon holds one in-flight source request per project, so the
// author's next edit waited behind it: measured answers at 14m 26s, 21m 10s and
// 53m 47s, all of them `stale-base`. The system got slower the more it was used.
//
// So the property under test is a cost, not a behaviour, which is why it is
// asserted through `durabilityProbe` — the snapshot is deleted by the time a push
// returns, and the only honest place to observe what it contained is while it is
// being written. A future recursive copy of `revisions/` would restore the old
// latency silently and no correctness test would notice.
//
// The correctness half is here too, and it is the same rollback: a stale-base
// push must leave the authority and the history exactly as it found them.
import assert from 'assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, sep } from 'path'
import { fileURLToPath } from 'url'

import {
  closeProjectStore,
  createProject,
  initProjectStore,
  outputDir,
  projectDir,
  readSourceFile,
  sourceLifecycleStore,
  updateProject,
} from '../server/lib/project-store.mjs'
import { processProjectPush } from '../server/routes/projects.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'tlda-source-transaction-cost-'))
await initProjectStore(root)

function suppressBuilds(name) {
  mkdirSync(outputDir(name), { recursive: true })
  writeFileSync(join(outputDir(name), 'relevant-files.json'), JSON.stringify({ files: ['not-this-test.tex'] }))
}

const MANIFEST = ['main.tex', 'notes.tex']

try {
  const name = 'source-transaction-cost'
  createProject({ name, title: name, mainFile: 'main.tex', format: 'svg' })
  await updateProject(name, { pages: 1, buildStatus: 'success' })
  suppressBuilds(name)

  // ### The paper accumulates a history
  // Two accepted revisions, so `revisions/` holds something a snapshot could be
  // tempted to copy. One revision would not distinguish a narrowed snapshot from
  // an empty project.
  const first = await processProjectPush(name, {
    expectedRevision: null,
    sourceManifest: MANIFEST,
    files: [
      { path: 'main.tex', content: 'first main\n' },
      { path: 'notes.tex', content: 'first notes\n' },
    ],
  })
  assert.equal(first.status, 200, 'the paper — records a first revision')

  const second = await processProjectPush(name, {
    expectedRevision: first.sourceRevision,
    sourceManifest: MANIFEST,
    files: [{ path: 'main.tex', content: 'second main\n' }],
  })
  assert.equal(second.status, 200, 'the paper — records a second revision')

  const lifecycleRoot = join(projectDir(name), '.source-lifecycle')
  const revisionsBefore = readdirSync(join(lifecycleRoot, 'revisions')).sort()
  assert.equal(revisionsBefore.length, 2, 'the revision history — holds both accepted revisions')

  // ### A push on a stale base is rejected, and rolls back
  // This is the live case, not a contrived one: the daemon sends the revision it
  // last saw, the server has moved on, and the transaction unwinds.
  const synced = []
  const stale = await processProjectPush(
    name,
    {
      expectedRevision: first.sourceRevision,
      sourceManifest: MANIFEST,
      files: [{ path: 'main.tex', content: 'stale main\n' }],
    },
    { durabilityProbe: (label, path) => synced.push(path) },
  )
  assert.equal(stale.status, 409, 'a push on a stale base — is refused')
  assert.equal(stale.lifecycleStatus, 'stale-base', 'a push on a stale base — is refused as stale-base')

  // ### The snapshot did not copy the history
  // `revisions/` and `blobs/` are content-addressed and append-only. Nothing in a
  // transaction rewrites an entry, so copying them in order to restore them
  // protects nothing — and it is the copy that costs the author his wait.
  const snapshotted = synced.filter(path => path.includes(`${sep}.source-transactions${sep}`))
  assert.ok(snapshotted.length > 0, 'the rollback snapshot — was written and synced; otherwise the paths below prove nothing')

  const copiedHistory = snapshotted.filter(path =>
    path.includes(`source-lifecycle${sep}revisions${sep}`) || path.includes(`source-lifecycle${sep}blobs${sep}`))
  assert.deepEqual(
    copiedHistory, [],
    'the rollback snapshot — copies no revision or blob; copying the history back into every push is what '
    + 'made a stale-base answer take tens of minutes and grow with every accepted revision',
  )

  const copiedAuthority = snapshotted.filter(path => path.endsWith(`source-lifecycle${sep}authority.json`))
  assert.equal(copiedAuthority.length, 1, 'the rollback snapshot — copies authority.json, which a transaction does rewrite')

  // ### The rollback put the mutable state back
  assert.equal(
    (await sourceLifecycleStore(name)).readAuthority().currentRevision, second.sourceRevision,
    'the source authority — still points at the second revision after the refused push',
  )
  assert.equal(readSourceFile(name, 'main.tex'), 'second main\n', 'the paper — still holds the second revision\'s text')

  // ### And it left the history alone
  // The path this replaces removed `.source-lifecycle` outright and copied a
  // snapshot back over it, so a failure between those two steps lost every
  // version of the paper. Nothing unlinks the history now.
  const revisionsAfter = readdirSync(join(lifecycleRoot, 'revisions')).sort()
  assert.deepEqual(
    revisionsBefore.filter(id => !revisionsAfter.includes(id)), [],
    'the revision history — loses nothing to a refused push',
  )
  assert.ok(existsSync(join(lifecycleRoot, 'operations.json')), 'the operations journal — survives a refused push')

  // ### The refused push leaves an unreferenced revision behind
  // `submit` writes the candidate revision before deciding, and the rollback no
  // longer clears the tree, so the refused candidate stays on disk. It is inert:
  // the restored authority does not name it, `readRevision` is only ever called
  // with an id from authority or the operations journal, and a later push of the
  // same content writes the same content-addressed path.
  //
  // It is not free either — one refused push leaves one revision's worth of
  // bytes, and bregman refused 13 pushes on 2026-08-17. Collecting them is a
  // readdir diff, not a copy, but it means unlinking under `revisions/` and that
  // is not being done tonight. Asserted here so the litter is a recorded
  // decision rather than something discovered later as a leak.
  const orphans = revisionsAfter.filter(id => !revisionsBefore.includes(id))
  assert.equal(orphans.length, 1, 'a refused push — leaves exactly one unreferenced revision behind')
  assert.notEqual(
    decodeURIComponent(orphans[0]), (await sourceLifecycleStore(name)).readAuthority().currentRevision,
    'the unreferenced revision — is not the one the authority points at',
  )

  // ### The next push still works
  const next = await processProjectPush(name, {
    expectedRevision: second.sourceRevision,
    sourceManifest: MANIFEST,
    files: [{ path: 'main.tex', content: 'third main\n' }],
  })
  assert.equal(next.status, 200, 'the paper — accepts the next push on the current base')
  assert.equal(readSourceFile(name, 'main.tex'), 'third main\n', 'the paper — holds the text of the accepted push')

  console.log('source transaction snapshot cost tests passed')
} finally {
  await closeProjectStore()
}
