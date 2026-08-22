#!/usr/bin/env node

/**
 * A conflicted checkout is announced as `synced`.
 *
 * Two things, both red at `e2545ebea` — the baseline this was written against,
 * named as a sha because `main` has since moved and now carries the repair. Run
 * against today's `main` both are green, and the honest conclusion available
 * from that alone is that there was never anything to fix. The three shas that
 * stay true: green at `e2545ebea`, red at `4821035a1`, green at `b0fba4946`.
 *
 * S IS RETIRED AS A GATE AND KEPT AS EVIDENCE. `d60d18573` — "Park accepted
 * revisions instead of writing the person's checkout" — removed its premise: no
 * arrival conflicts a checkout any more, so there is no conflicted outcome to
 * compare a clean one against. From that commit onward S reports
 * `FIXTURE NOT CAPABLE` and exits 2. That is the harness declining to give a
 * verdict, not a pass and not a failure, and it is why this file is kept rather
 * than deleted: it is the record of what the broadcast did when a conflicted
 * arrival was still reachable.
 *
 * W. THE WIRE. `headChanged()` -> `fetchHead()` -> `mirrorArrived()` in
 *    `daemon/git-project-sync.mjs`, with the fetch really happening over a
 *    remote, conflicts the person's checkout. The previous test called
 *    `mirrorArrived()` directly; this one does not, so the fetch-to-apply
 *    connection is exercised rather than assumed.
 *
 * S. THE STATUS. `createSourceRoomDaemon(...).headChanged()` in
 *    `server/lib/source-room-daemon.mjs` computes a result from the git sync at
 *    line 447 and then broadcasts `{type:'status', status:'synced'}` at line 455
 *    without consulting it. The assertion is a property of the running system
 *    rather than a claim about anybody's intent: the message a subscriber
 *    receives is BYTE-IDENTICAL whether the sync succeeded or conflicted, so the
 *    status a person can see carries no information about what happened to the
 *    files.
 *
 * Run:  node bin/a-conflicted-checkout-reports-synced-test.mjs
 */

import assert from 'assert/strict'
import { execFile as execFileCb } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { createGitProjectSync } from '../daemon/git-project-sync.mjs'
import { createSourceRoomDaemon } from '../server/lib/source-room-daemon.mjs'
import { snapshotUserTerritory, diffUserTerritory } from './lib/user-territory.mjs'

const execFileP = promisify(execFileCb)

const PROJECT = 'fixture-paper'
const SHARED_REF = `refs/tlda/source/${PROJECT}`
const FETCHED_REF = `refs/tlda/fetched/${PROJECT}`

async function git(cwd, args) {
  return execFileP('git', args, { cwd, timeout: 120000, maxBuffer: 64 * 1024 * 1024 })
}

async function gitOrNull(cwd, args) {
  try { return (await git(cwd, args)).stdout.trim() } catch { return null }
}

async function initRepo(dir, branch = 'main') {
  await git(dir, ['init', '-b', branch])
  await git(dir, ['config', 'user.name', 'fixture'])
  await git(dir, ['config', 'user.email', 'fixture@example.test'])
}

async function write(file, content) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true })
  await fs.promises.writeFile(file, content)
}

async function makeUserCheckout(root, label, content) {
  const dir = await fs.promises.mkdtemp(path.join(root, `user-${label}-`))
  await initRepo(dir)
  await write(path.join(dir, 'main.tex'), content)
  await git(dir, ['add', 'main.tex'])
  await git(dir, ['commit', '-m', 'the author writes their paper'])
  return dir
}

/**
 * A remote the daemon can really fetch from. `fetchHead()` asks for
 * `refs/tlda/source/<project>`, so the fixture publishes the accepted revision
 * under exactly that ref rather than under a branch.
 */
async function makeRemote(root, label, files) {
  const dir = await fs.promises.mkdtemp(path.join(root, `remote-${label}-`))
  await initRepo(dir)
  for (const [rel, content] of Object.entries(files)) await write(path.join(dir, rel), content)
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '-m', 'server accepted a revision'])
  const revision = (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim()
  await git(dir, ['update-ref', SHARED_REF, revision])
  return { dir, revision }
}

function makeSync(sourceDir, remote) {
  return createGitProjectSync({
    sourceDir,
    project: PROJECT,
    daemonId: 'fixture-daemon',
    bindingId: 'fixture-binding',
    branch: 'main',
    remote,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  })
}

// ---------------------------------------------------------------------------
// W. The wire: headChanged -> fetchHead -> mirrorArrived, fetch really running.
// ---------------------------------------------------------------------------

async function wireScenario(root) {
  console.log('\nW. THE WIRE: headChanged() -> fetchHead() -> mirrorArrived(), real fetch')
  const user = await makeUserCheckout(root, 'wire', 'the authoritative work, already local\n')
  const { dir: remote, revision } = await makeRemote(root, 'wire', {
    'main.tex': 'what the server thinks the paper says\n',
  })

  // Positive control on the input: the fetched ref must not exist yet, or a
  // later reading of it proves nothing about this fetch.
  const fetchedBefore = await gitOrNull(user, ['rev-parse', '--verify', FETCHED_REF])
  console.log(`  ${FETCHED_REF} before: ${fetchedBefore ?? '(absent)'}`)
  assert.equal(fetchedBefore, null, 'fixture is not clean: the fetched ref already exists')

  const before = await snapshotUserTerritory(user)
  console.log(`  the person stands on ${before.symbolicHead} at ${before.head}`)
  console.log(`  the remote publishes ${SHARED_REF} = ${revision}`)

  // headChanged() only. mirrorArrived() is never called by this test.
  const result = await makeSync(user, remote).headChanged(revision)
  console.log(`  headChanged returned status=${result.status} ok=${result.ok}`)

  const fetchedAfter = await gitOrNull(user, ['rev-parse', '--verify', FETCHED_REF])
  console.log(`  ${FETCHED_REF} after:  ${fetchedAfter ?? '(absent)'}`)
  const fetchHappened = fetchedAfter === revision
  console.log(`  the fetch really ran and delivered the revision: ${fetchHappened}`)

  const after = await snapshotUserTerritory(user)
  const violations = diffUserTerritory(before, after)
  if (violations.length === 0) {
    console.log('  user territory unchanged')
  } else {
    console.log(`  ${violations.length} write(s) into user territory:`)
    for (const violation of violations) console.log(`    * ${violation}`)
  }

  const mergeHead = after.inProgress.MERGE_HEAD
  console.log(`  MERGE_HEAD in the person's checkout: ${mergeHead ?? '(absent)'}`)

  return {
    label: 'W',
    capable: fetchHappened,
    failed: violations.length > 0,
    note: `fetch delivered=${fetchHappened}, status=${result.status}`,
  }
}

// ---------------------------------------------------------------------------
// S. The status: what a subscriber is told when the sync conflicted.
// ---------------------------------------------------------------------------

function fakeSubscriber(received) {
  return {
    readyState: 1,
    send(payload) { received.push(JSON.parse(payload)) },
    close() {},
  }
}

/**
 * Stand up the real source-room daemon over a real git sync bound to `userDir`,
 * announce `revision`, and return every message the subscriber received plus
 * what the git sync actually returned.
 */
async function announceInto(root, label, userDir, remote, revision) {
  const projectsRoot = await fs.promises.mkdtemp(path.join(root, `rooms-${label}-`))
  const sync = makeSync(userDir, remote)
  let syncResult = null

  const daemon = createSourceRoomDaemon({
    projectDir: project => path.join(projectsRoot, project),
    readProject: async name => ({ name, mainFile: 'main.tex' }),
    sourceLifecycleStore: async () => ({
      // null head, so creating the room does not itself announce a revision.
      gitRepository: async () => ({ head: async () => null }),
      readCurrentFile: async () => ({ content: Buffer.from('the authoritative work, already local\n') }),
    }),
    readClientSourceManifest: async () => ['main.tex'],
    // The real project sync, bound to a real checkout. Only the manager wrapper
    // is a fixture, and all it does is forward and record.
    gitSyncManagerForProject: () => ({
      bindSource: () => {},
      sync: async () => {},
      queuePaths: () => {},
      headChanged: async (_project, rev) => {
        syncResult = await sync.headChanged(rev)
        return syncResult
      },
    }),
    pushDelayMs: 5,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  })

  const received = []
  try {
    const room = await daemon.getRoom(PROJECT, 'main.tex')
    room.clients.add(fakeSubscriber(received))
    await daemon.headChanged(PROJECT, revision)
  } finally {
    daemon.closeAll()
  }
  return { received: received.filter(m => m.type === 'status'), syncResult }
}

async function statusScenario(root) {
  console.log('\nS. THE STATUS: what a subscriber is told about a conflicted arrival')

  // The conflicting arrival: same path, different content, so the merge cannot
  // resolve and the sync genuinely returns conflicted.
  const conflictUser = await makeUserCheckout(root, 'conflict', 'the authoritative work, already local\n')
  const conflictRemote = await makeRemote(root, 'conflict', {
    'main.tex': 'what the server thinks the paper says\n',
  })
  const conflicted = await announceInto(root, 'conflict', conflictUser, conflictRemote.dir, conflictRemote.revision)

  // The clean arrival, as the control: disjoint paths, so the same code path
  // succeeds. If the two broadcasts are identical, the status is not reporting.
  const cleanUser = await makeUserCheckout(root, 'clean', 'the authoritative work, already local\n')
  const cleanRemote = await makeRemote(root, 'clean', {
    'appendix.tex': 'a section only the server has\n',
  })
  const clean = await announceInto(root, 'clean', cleanUser, cleanRemote.dir, cleanRemote.revision)

  console.log(`  conflicting arrival: git sync returned ok=${conflicted.syncResult?.ok} status=${conflicted.syncResult?.status}`)
  console.log(`  clean arrival:       git sync returned ok=${clean.syncResult?.ok} status=${clean.syncResult?.status}`)

  const conflictMergeHead = (await snapshotUserTerritory(conflictUser)).inProgress.MERGE_HEAD
  console.log(`  the conflicting checkout holds MERGE_HEAD: ${conflictMergeHead ?? '(absent)'}`)

  // Positive control on the input: if the two arrivals did not actually differ
  // in outcome, comparing what was broadcast about them establishes nothing.
  const capable = conflicted.syncResult?.status === 'conflicted' && clean.syncResult?.ok === true
  if (!capable) {
    console.log('  FIXTURE NOT CAPABLE: the two arrivals did not produce different outcomes.')
    return { label: 'S', capable: false, failed: false, note: 'outcomes did not differ' }
  }

  const conflictStatus = conflicted.received.at(-1)
  const cleanStatus = clean.received.at(-1)
  console.log(`  broadcast after the CONFLICTING arrival: ${JSON.stringify(conflictStatus)}`)
  console.log(`  broadcast after the CLEAN arrival:       ${JSON.stringify(cleanStatus)}`)

  const saysSynced = conflictStatus?.status === 'synced'
  const identical = JSON.stringify({ ...conflictStatus, sourceRevision: null })
    === JSON.stringify({ ...cleanStatus, sourceRevision: null })
  console.log(`  the conflicting arrival was announced as synced: ${saysSynced}`)
  console.log(`  the two broadcasts are identical apart from the revision: ${identical}`)

  return {
    label: 'S',
    capable: true,
    failed: saysSynced || identical,
    note: `saysSynced=${saysSynced}, identical=${identical}`,
  }
}

async function main() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tlda-synced-status-'))
  let results = []
  try {
    // Negative control: the same instrument, nothing invoked.
    console.log('NEGATIVE CONTROL: same fixture, neither path invoked')
    const control = await makeUserCheckout(root, 'control', 'the authoritative work, already local\n')
    const controlBefore = await snapshotUserTerritory(control)
    await git(control, ['status', '--porcelain'])
    const controlAfter = await snapshotUserTerritory(control)
    const controlViolations = diffUserTerritory(controlBefore, controlAfter)
    if (controlViolations.length > 0) {
      console.log('\nBROKEN HARNESS: the assertion reports writes when nothing ran.')
      process.exit(2)
    }
    console.log('  user territory unchanged — the instrument is quiet when nothing runs')

    results = [await wireScenario(root), await statusScenario(root)]

    console.log('\n' + '='.repeat(72))
    for (const r of results) {
      console.log(`  ${r.label}: ${r.failed ? 'RED' : 'not red'} — ${r.note}${r.capable ? '' : ' [FIXTURE NOT CAPABLE]'}`)
    }
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
  const failed = results.some(r => r.failed)
  const incapable = results.some(r => !r.capable)
  if (failed) {
    console.log('\nFAIL: a conflicted arrival writes the checkout and is announced as synced.')
  } else if (incapable) {
    console.log('\nINCONCLUSIVE: a fixture was not shown capable of producing the outcome.')
  } else {
    console.log('\nPASS.')
  }
  process.exit(failed ? 1 : incapable ? 2 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(3)
})
