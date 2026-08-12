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
  // ## Restart rolls back a half-written source transaction
  //
  // The server dies after writing files to disk but before the source authority
  // records the revision. On restart, disk and authority have to agree again on
  // the last recorded revision, and the next editor save must still work.
  const name = 'source-restart-mid-edit'
  createProject({ name, title: name, mainFile: 'main.tex', format: 'svg' })
  await updateProject(name, { pages: 1, buildStatus: 'success' })
  suppressBuilds(name)

  // ### The paper starts at a recorded base revision
  const base = await processProjectPush(name, {
    expectedRevision: null,
    sourceManifest: MANIFEST,
    files: [
      { path: 'main.tex', content: 'base main\n' },
      { path: 'notes.tex', content: 'base notes\n' },
    ],
  })
  assert.equal(base.status, 200, 'the paper — starts at a recorded base revision')
  await closeProjectStore()

  // ### The server dies inside the source transaction
  const childPath = join(root, 'crash-child.mjs')
  writeFileSync(childPath, CHILD)
  let died = false
  try {
    execFileSync(process.execPath, [childPath, root, name], { stdio: 'pipe' })
  } catch (error) {
    died = error.signal === 'SIGKILL'
  }
  // A precondition, not an expectation: if the child was not really killed,
  // everything below measures an ordinary clean run and proves nothing about
  // recovery. That distinction is why the consequence stays in the message.
  assert.equal(
    died, true,
    'the server process — dies inside the source transaction; otherwise it exited cleanly and '
    + 'nothing below is testing a crash at all',
  )

  await initProjectStore(root)

  // ### Disk is ahead of the authority before recovery
  // The window is real: disk carries text no revision records. If this ever
  // stops being true the crash is landing somewhere else and the rest of the
  // test is proving nothing.
  assert.equal(readSourceFile(name, 'main.tex'), 'half-written main\n', 'the disk — has half-written main.tex before recovery')
  assert.equal(readSourceFile(name, 'notes.tex'), 'half-written notes\n', 'the disk — has half-written notes.tex before recovery')
  assert.equal((await sourceLifecycleStore(name)).readAuthority().currentRevision, base.sourceRevision, 'the source authority — still points at the recorded base revision')

  const orphans = await listProjectSourceRecoveries(name)
  assert.equal(orphans.length, 1, 'the recovery ledger — has one killed transaction snapshot')
  assert.equal(orphans[0].state, 'snapshot-ready', 'the recovery ledger — marks the killed transaction snapshot ready')

  // ### The server restarts
  // Restart. This is what the server does on boot.
  const recovered = await recoverProjectSourceTransactions(name)
  assert.deepEqual(recovered, [{ id: orphans[0].id, state: 'snapshot-rolled-back-cleaned' }], 'the recovery ledger — rolls the killed transaction back and cleans it')

  // ### Disk and authority agree again
  // Disk and the authority agree again, and they agree on the last revision
  // that was actually recorded. Either of them landing on the half-written
  // text alone is the divergence this whole file is about.
  assert.equal(readSourceFile(name, 'main.tex'), 'base main\n', 'the disk — has base main.tex after recovery')
  assert.equal(readSourceFile(name, 'notes.tex'), 'base notes\n', 'the disk — has base notes.tex after recovery')
  assert.equal((await sourceLifecycleStore(name)).readAuthority().currentRevision, base.sourceRevision, 'the source authority — still points at the recorded base revision after recovery')
  assert.deepEqual(await listProjectSourceRecoveries(name), [], 'the recovery ledger — has no remaining source transaction snapshots')

  // ### Alice saves after the restart
  // And the project is not wedged. Somebody whose editor was open through the
  // restart still holds the base revision; their next keystroke has to save.
  const afterRestart = await processProjectPush(name, {
    expectedRevision: base.sourceRevision,
    sourceManifest: MANIFEST,
    files: [{ path: 'main.tex', content: 'after restart main\n' }],
  })
  assert.equal(afterRestart.status, 200, "Alice's save — accepted after the restart")
  assert.equal(readSourceFile(name, 'main.tex'), 'after restart main\n', 'the paper — has Alice’s post-restart main.tex')
  assert.equal(readSourceFile(name, 'notes.tex'), 'base notes\n', 'the paper — still has base notes.tex after Alice saves')
  assert.equal((await sourceLifecycleStore(name)).readAuthority().currentRevision, afterRestart.sourceRevision, 'the source authority — moves to Alice’s post-restart revision')

  // ## Restart cleans a journal before any file is written
  //
  // The same recovery path also runs when the process dies after writing the
  // journal but before touching files. The next push should clean that journal
  // and save normally.

  // ### The paper starts at a recorded base revision
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
  assert.equal(crashedBase.status, 200, 'the paper — starts at a recorded base revision before the journal-only crash')

  // ### The push dies after the journal
  const simulated = await processProjectPush(crashed, {
    expectedRevision: crashedBase.sourceRevision,
    sourceManifest: MANIFEST,
    files: [{ path: 'main.tex', content: 'never landed\n' }],
  }, { simulateCrashAfterJournal: true })
  assert.equal(simulated.status, 598, 'the source push — dies after writing its journal')
  assert.equal(readSourceFile(crashed, 'main.tex'), 'base main\n', 'the disk — still has base main.tex after the journal-only crash')

  // ### Alice retries her save
  const retry = await processProjectPush(crashed, {
    expectedRevision: crashedBase.sourceRevision,
    sourceManifest: MANIFEST,
    files: [{ path: 'main.tex', content: 'retried main\n' }],
  })
  assert.equal(retry.status, 200, "Alice's retry — accepted after recovery cleans the journal")
  assert.equal(readSourceFile(crashed, 'main.tex'), 'retried main\n', 'the paper — has Alice’s retried main.tex')
  assert.deepEqual(await listProjectSourceRecoveries(crashed), [], 'the recovery ledger — has no remaining journal-only crash entry')

  console.log('source restart mid-edit tests passed')
} finally {
  await closeProjectStore()
}
