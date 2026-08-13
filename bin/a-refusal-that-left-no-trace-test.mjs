#!/usr/bin/env node
// A refusal that left no trace, and the person nobody knew was stuck.
//
// Conflict state is written from the classifications that came back saying
// `conflict` — files with marker text in them. So a refusal where nothing
// produced markers recorded nothing at all: the pusher learned from their HTTP
// status, and every other instrument said the paper was fine.
//
// Figures are the ordinary way to get there rather than an exotic one. There is
// no three-way merge for bytes, so two people who replace the same figure
// produce a refusal with no markers anywhere in it — the same shape as the
// bibliography refusal measured on a real paper on 2026-08-13.
//
// This crosses the real push route rather than calling the lifecycle store,
// because recording is something the route does with what the lifecycle
// refused. Calling both halves from one process would prove both halves and
// nothing about whether the refusal reaches the record.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  closeProjectStore,
  createProject,
  initProjectStore,
  listProjects,
  outputDir,
  readProject,
  updateProject,
} from '../server/lib/project-store.mjs'
import { processProjectPush } from '../server/routes/projects.mjs'
import { sourceSyncLedger, sourceSyncIsStale, staleSourceSyncEntries } from '../server/lib/source-sync-conflicts.mjs'
import { daemonOn, everyoneArrivesAt } from './lib/source-collaborators.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-silent-refusal-'))
await initProjectStore(root)

const PROJECT = 'paper-nobody-is-watching'
const MANIFEST = ['fig.png', 'main.tex', 'refs.bib'].sort()
const MINUTE = 60_000

const png = tail => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...tail])
const opening = path => (path.endsWith('.png')
  ? { content: png([1, 2, 3]).toString('base64'), encoding: 'base64' }
  : { content: `${path} as it started\n` })

const ledgerNow = async (now) => sourceSyncLedger(await readProject(PROJECT), now)

try {
  createProject({ name: PROJECT, title: PROJECT, mainFile: 'main.tex', format: 'svg' })
  await updateProject(PROJECT, { pages: 1, buildStatus: 'success' })
  mkdirSync(outputDir(PROJECT), { recursive: true })
  writeFileSync(join(outputDir(PROJECT), 'relevant-files.json'), JSON.stringify({ files: ['not-this-test.tex'] }))

  const started = await processProjectPush(PROJECT, {
    expectedRevision: null,
    sourceManifest: MANIFEST,
    files: MANIFEST.map(path => ({ path, ...opening(path) })),
  })
  assert.deepEqual({ status: started.status, error: started.error }, { status: 200, error: undefined },
    'the paper — exists, with a figure in it, before anyone edits anything')

  // ## Two people replace the same figure, and one of them is refused

  // ### Alice and Bob pull the same draft
  const alice = daemonOn('Alice', 'her laptop', PROJECT, MANIFEST)
  const bob = daemonOn('Bob', 'his desktop', PROJECT, MANIFEST)
  await everyoneArrivesAt(alice, bob)
  assert.equal(alice.heldRevision, bob.heldRevision,
    'both machines — start from the same revision; otherwise they are not editing the same draft')

  // ### Alice replaces the figure and lands it
  const hers = await alice.pushes.call(alice.edits('fig.png', png([9, 9, 9]), { encoding: 'base64' }))
  assert.deepEqual({ status: hers.status, error: hers.error }, { status: 200, error: undefined },
    "Alice's laptop — lands her figure; otherwise she was refused and she pushed first")

  // ### Bob replaces the same figure, still holding the draft they both pulled
  const his = await bob.pushes.call(bob.edits('fig.png', png([7, 7, 7]), { encoding: 'base64' }))
  assert.equal(his.status, 409,
    "Bob's desktop — is refused, because two sets of bytes are not a thing that can be merged")
  assert.deepEqual(his.conflictFiles, undefined,
    'the refusal — names no conflicted file, because there are no markers to write into one; '
    + 'this is the case that used to record nothing anywhere')

  // ### The paper knows somebody is stuck, even with nothing to show them
  const stuck = await ledgerNow(Date.now())
  assert.equal(stuck.entries.length, 1,
    'the ledger — holds Bob; otherwise his figure sits on his desktop and the paper looks untroubled, '
    + 'which is what happened on a real paper before this existed')
  assert.equal(stuck.entries[0].status, 'refused',
    "Bob's entry — says he was refused rather than that a file is conflicted, because no file of his is")
  assert.equal(stuck.entries[0].owner.machineId, bob.machineId,
    "the stuck work — is named to Bob's machine, so it says whose figure is in one place")
  assert.deepEqual(stuck.entries[0].files, ['fig.png'],
    'the entry — names what he was carrying, so it is answerable rather than only alarming')

  // ### Nothing is shown to anyone, because that is not this decision
  const shown = (await readProject(PROJECT)).sourceSyncConflicts || []
  assert.deepEqual(shown, [],
    'the conflict pill — still shows nothing, because what a person is shown is a product decision '
    + 'and this is only the record that they are stuck')

  // ### The sweep sees it through the store, not only through a project object
  //
  // The periodic check reads `listProjects()` rather than the object this story
  // has in hand, and a field that does not survive that read would leave the
  // sweep reporting an empty fleet forever while every unit assertion above
  // still passed.
  const everywhere = staleSourceSyncEntries(await listProjects(), 30 * MINUTE, Date.now() + 9 * 60 * MINUTE)
  assert.deepEqual(everywhere.map(entry => [entry.project, entry.file]), [[PROJECT, 'fig.png']],
    'the sweep — finds Bob through the same call the server makes on its timer; otherwise the field never '
    + 'survives the store read and the instrument is silent for a reason no test would show')

  // ## Being stuck for a minute is working; being stuck since last night is not

  // ### A minute after Bob was refused
  const fresh = await ledgerNow(Date.now() + MINUTE)
  assert.equal(sourceSyncIsStale(fresh, 30 * MINUTE), false,
    'the paper — raises nothing, because two people editing the same figure a minute apart is two people working')

  // ### Nine hours after Bob was refused, and he has not pushed again
  const overnight = await ledgerNow(Date.now() + 9 * 60 * MINUTE)
  assert.equal(sourceSyncIsStale(overnight, 30 * MINUTE), true,
    "the paper — raises, because Bob's figure has been in exactly one place all night")

  // ## Bob lands something, and stops being counted as stuck
  //
  // Per person rather than per file: being stuck is a fact about somebody whose
  // machine cannot reach the paper, and once anything of theirs lands, it can.
  // His figure is still his to resolve, and that is a conflict rather than this.

  // ### He pulls what Alice landed and pushes again
  await everyoneArrivesAt(bob)
  const retried = await bob.pushes.call(bob.edits('refs.bib', 'bob adds a citation\n'))
  assert.deepEqual({ status: retried.status, error: retried.error }, { status: 200, error: undefined },
    "Bob's desktop — lands once he is holding the current draft")

  // ### The ledger lets him go
  const settled = await ledgerNow(Date.now() + 9 * 60 * MINUTE)
  assert.deepEqual(settled.entries, [],
    'the ledger — is empty; otherwise it reports people as stuck after their work arrived, and an alarm '
    + 'that never clears is one nobody reads')
  assert.equal(sourceSyncIsStale(settled, 30 * MINUTE), false,
    'the paper — raises nothing, because nobody is outside it')

  console.log('a refusal that left no trace: the paper records who is stuck, ages it, and lets them go')
} finally {
  await closeProjectStore?.()
  rmSync(root, { recursive: true, force: true })
}
