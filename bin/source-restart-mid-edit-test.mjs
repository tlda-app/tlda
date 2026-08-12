#!/usr/bin/env node
// A restart in the middle of somebody's edit.
//
// The dangerous state is narrow and it is real: a push snapshots the source,
// writes the new bytes to disk, and only then asks the lifecycle store to
// record a revision. A process that dies inside that window leaves disk
// carrying text the authority has never heard of — stored state diverging
// from what a reader sees, which is the case tests are for.
//
// The crash here is a real SIGKILL of a real child process, not an injected
// throw. A throw runs the rollback; a restart does not, and rollback is the
// thing under test. What survives is only what was on the filesystem.
//
// Existing crash coverage in bin/source-manifest-contract-test.mjs is all
// Overleaf-linked (overleaf-crash-after-publish, overleaf-compensation-race),
// where recovery is adjudicated against a remote head. A plain project has no
// remote to ask, so its whole answer is the transaction snapshot.
import assert from 'assert/strict'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import {
  closeProjectStore,
  createProject,
  initProjectStore,
  listProjectSourceRecoveries,
  outputDir,
  readSourceFile,
  sourceLifecycleStore,
  updateProject,
} from '../server/lib/project-store.mjs'
import { recoverProjectSourceTransactions } from '../server/lib/overleaf-sync.mjs'
import { processProjectPush } from '../server/routes/projects.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'tlda-source-restart-'))
await initProjectStore(root)

function suppressBuilds(name) {
  mkdirSync(outputDir(name), { recursive: true })
  writeFileSync(join(outputDir(name), 'relevant-files.json'), JSON.stringify({ files: ['not-this-test.tex'] }))
}

const MANIFEST = ['main.tex', 'notes.tex']

// The child does what the push route does, in the same order, and then dies
// where the route would have committed. It is killed with SIGKILL from inside
// itself so the death lands at a known point rather than a hoped-for one.
const CHILD = `
import { beginProjectSourceTransaction, initProjectStore, writeSourceFileAsync } from ${JSON.stringify(join(repoRoot, 'server/lib/project-store.mjs'))}
const [root, name] = process.argv.slice(2)
await initProjectStore(root)
await beginProjectSourceTransaction(name, { originalLocalHead: null })
await writeSourceFileAsync(name, 'main.tex', Buffer.from('half-written main\\n'))
await writeSourceFileAsync(name, 'notes.tex', Buffer.from('half-written notes\\n'))
process.kill(process.pid, 'SIGKILL')
`

try {
  const name = 'source-restart-mid-edit'
  createProject({ name, title: name, mainFile: 'main.tex', format: 'svg' })
  await updateProject(name, { pages: 1, buildStatus: 'success' })
  suppressBuilds(name)

  const base = await processProjectPush(name, {
    expectedRevision: null,
    sourceManifest: MANIFEST,
    files: [
      { path: 'main.tex', content: 'base main\n' },
      { path: 'notes.tex', content: 'base notes\n' },
    ],
  })
  assert.equal(base.status, 200, base.error)
  await closeProjectStore()

  const childPath = join(root, 'crash-child.mjs')
  writeFileSync(childPath, CHILD)
  let died = false
  try {
    execFileSync(process.execPath, [childPath, root, name], { stdio: 'pipe' })
  } catch (error) {
    died = error.signal === 'SIGKILL'
  }
  assert.equal(died, true, 'the child had to actually be killed for this to test anything')

  await initProjectStore(root)

  // The window is real: disk carries text no revision records. If this ever
  // stops being true the crash is landing somewhere else and the rest of the
  // test is proving nothing.
  assert.equal(readSourceFile(name, 'main.tex'), 'half-written main\n')
  assert.equal(readSourceFile(name, 'notes.tex'), 'half-written notes\n')
  assert.equal((await sourceLifecycleStore(name)).readAuthority().currentRevision, base.sourceRevision)

  const orphans = await listProjectSourceRecoveries(name)
  assert.equal(orphans.length, 1, 'the killed transaction must leave its snapshot behind')
  assert.equal(orphans[0].state, 'snapshot-ready')

  // Restart. This is what the server does on boot.
  const recovered = await recoverProjectSourceTransactions(name)
  assert.deepEqual(recovered, [{ id: orphans[0].id, state: 'snapshot-rolled-back-cleaned' }])

  // Disk and the authority agree again, and they agree on the last revision
  // that was actually recorded. Either of them landing on the half-written
  // text alone is the divergence this whole file is about.
  assert.equal(readSourceFile(name, 'main.tex'), 'base main\n')
  assert.equal(readSourceFile(name, 'notes.tex'), 'base notes\n')
  assert.equal((await sourceLifecycleStore(name)).readAuthority().currentRevision, base.sourceRevision)
  assert.deepEqual(await listProjectSourceRecoveries(name), [])

  // And the project is not wedged. Somebody whose editor was open through the
  // restart still holds the base revision; their next keystroke has to save.
  const afterRestart = await processProjectPush(name, {
    expectedRevision: base.sourceRevision,
    sourceManifest: MANIFEST,
    files: [{ path: 'main.tex', content: 'after restart main\n' }],
  })
  assert.equal(afterRestart.status, 200, afterRestart.error)
  assert.equal(readSourceFile(name, 'main.tex'), 'after restart main\n')
  assert.equal(readSourceFile(name, 'notes.tex'), 'base notes\n')
  assert.equal((await sourceLifecycleStore(name)).readAuthority().currentRevision, afterRestart.sourceRevision)

  // The other half of the same story: a push that dies right after its journal
  // is written, before it touches a single file. Recovery runs on the next
  // push rather than at boot, and the person must not have to know that.
  const crashed = 'source-restart-before-write'
  createProject({ name: crashed, title: crashed, mainFile: 'main.tex', format: 'svg' })
  await updateProject(crashed, { pages: 1, buildStatus: 'success' })
  suppressBuilds(crashed)

  const crashedBase = await processProjectPush(crashed, {
    expectedRevision: null,
    sourceManifest: MANIFEST,
    files: [
      { path: 'main.tex', content: 'base main\n' },
      { path: 'notes.tex', content: 'base notes\n' },
    ],
  })
  assert.equal(crashedBase.status, 200, crashedBase.error)

  const simulated = await processProjectPush(crashed, {
    expectedRevision: crashedBase.sourceRevision,
    sourceManifest: MANIFEST,
    files: [{ path: 'main.tex', content: 'never landed\n' }],
  }, { simulateCrashAfterJournal: true })
  assert.equal(simulated.status, 598)
  assert.equal(readSourceFile(crashed, 'main.tex'), 'base main\n')

  const retry = await processProjectPush(crashed, {
    expectedRevision: crashedBase.sourceRevision,
    sourceManifest: MANIFEST,
    files: [{ path: 'main.tex', content: 'retried main\n' }],
  })
  assert.equal(retry.status, 200, retry.error)
  assert.equal(readSourceFile(crashed, 'main.tex'), 'retried main\n')
  assert.deepEqual(await listProjectSourceRecoveries(crashed), [])

  console.log('source restart mid-edit tests passed')
} finally {
  await closeProjectStore()
}
