#!/usr/bin/env node

/**
 * The app does not touch the branch the person is standing on.
 *
 * Rule (relayed, not quoted): app/daemon never touches main; an explicitly
 * user-invoked relay owns merge-to-main and push.
 *
 * An earlier version of this file carried an all-caps sentence attributed to
 * Skip verbatim. It is not in the record as his typing — it reached the lane
 * through a brief that labelled it a quotation, and a message sent from his seat
 * is not evidence of authorship, because his seat carries other agents' text.
 * The substance is not in question; the attribution was.
 *
 * This exercises the real sync path — `createGitProjectSync(...).mirrorArrived`
 * from `daemon/git-project-sync.mjs`, the function that runs when the server
 * announces an accepted revision — against a disposable fixture checkout, and
 * then reads ordinary Git state. It asserts nothing about the source; it asserts
 * what a person would see in their own repository afterward.
 *
 * Two scenarios, because the path has two exits and both land in the person's
 * repository:
 *
 *   A. the merge succeeds — their branch now descends from server history
 *   B. the merge conflicts — the merge is left in progress, in their checkout
 *
 * The negative control runs first. A red test whose fixture never reached the
 * code is indistinguishable from a red test that found something, so the control
 * establishes that the snapshot reports "unchanged" when nothing ran. There is a
 * positive control too, on the input side: each scenario asserts that the fetch
 * really delivered the revision, because a path that never ran leaves user
 * territory alone and would otherwise read as a pass.
 *
 * The scenarios drive `headChanged()`, the entry point the daemon calls. An
 * earlier version drove `mirrorArrived()` directly; when the accept path is
 * deleted that function does not exist and the harness errors instead of
 * reporting, which is not the same as passing.
 *
 * Run:  node bin/app-does-not-touch-user-branch-test.mjs
 */

import { execFile as execFileCb } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { createGitProjectSync } from '../daemon/git-project-sync.mjs'
import { snapshotUserTerritory, diffUserTerritory, fetchedHistoryIsAncestry } from './lib/user-territory.mjs'

const execFileP = promisify(execFileCb)

const PROJECT = 'fixture-paper'
const SHARED_REF = `refs/tlda/source/${PROJECT}`
const FETCHED_REF = `refs/tlda/fetched/${PROJECT}`

async function gitOrNull(cwd, args) {
  try { return (await git(cwd, args)).stdout.trim() } catch { return null }
}

async function git(cwd, args) {
  return execFileP('git', args, { cwd, timeout: 120000, maxBuffer: 64 * 1024 * 1024 })
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

/**
 * A person's checkout, standing on `main`, in the ordinary state of a paper
 * someone is working on: committed history that already holds their work, an
 * uncommitted edit on disk, and an untracked file of their own that has nothing
 * to do with the paper.
 */
async function makeUserCheckout(root, label, { dirty = false } = {}) {
  const dir = await fs.promises.mkdtemp(path.join(root, `user-${label}-`))
  await initRepo(dir)
  await write(path.join(dir, 'main.tex'), 'the authoritative work, already local\n')
  await git(dir, ['add', 'main.tex'])
  await git(dir, ['commit', '-m', 'the author writes their paper'])
  if (dirty) {
    await write(path.join(dir, 'main.tex'), 'the authoritative work, already local, still being typed\n')
    await write(path.join(dir, 'scratch-notes.txt'), 'my own file, nothing to do with the paper\n')
  }
  return dir
}

/**
 * A remote the daemon can really fetch from. `fetchHead()` asks for
 * `refs/tlda/source/<project>`, so the fixture publishes the accepted revision
 * under exactly that ref rather than under a branch.
 */
async function makeRemote(root, label, files) {
  const server = await fs.promises.mkdtemp(path.join(root, `server-${label}-`))
  await initRepo(server)
  for (const [rel, content] of Object.entries(files)) await write(path.join(server, rel), content)
  await git(server, ['add', '-A'])
  await git(server, ['commit', '-m', 'server accepted a revision'])
  const { stdout } = await git(server, ['rev-parse', 'HEAD'])
  const revision = stdout.trim()
  await git(server, ['update-ref', SHARED_REF, revision])
  return { dir: server, revision }
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

function report(violations) {
  if (violations.length === 0) {
    console.log('  user territory unchanged')
    return
  }
  console.log(`  ${violations.length} write(s) into user territory:`)
  for (const violation of violations) console.log(`    * ${violation}`)
}

/**
 * Run one scenario and say what happened to the person's repository.
 * Returns true when the app wrote something it does not own.
 */
async function scenario({ root, label, title, dirty = false, serverFiles }) {
  console.log(`\nSCENARIO ${label}: ${title}`)
  const user = await makeUserCheckout(root, label, { dirty })
  const { dir: server, revision } = await makeRemote(root, label, serverFiles)

  // Capability control, part one: the fetched ref must not exist yet, or reading
  // it afterward says nothing about this run.
  const fetchedBefore = await gitOrNull(user, ['rev-parse', '--verify', FETCHED_REF])

  const before = await snapshotUserTerritory(user)
  console.log(`  the person stands on ${before.symbolicHead} at ${before.head}`)
  console.log(`  the server's accepted revision is ${revision}`)

  // headChanged() is the entry point the daemon calls, and the only one that
  // survives both contracts. Driving mirrorArrived() directly, as this test used
  // to, cannot run at all once the accept path is deleted — the harness errors
  // rather than reporting, which is not the same as passing.
  const result = await makeSync(user, server).headChanged(revision)
  console.log(`  headChanged returned status=${result.status} ok=${result.ok}`)

  // The territory measurement is unconditional. An earlier version of this test
  // returned before it when the status was unexpected, and so never looked at
  // the checkout — which hid real writes behind a fixture note.
  const after = await snapshotUserTerritory(user)
  const violations = diffUserTerritory(before, after)
  report(violations)

  const ancestry = await fetchedHistoryIsAncestry(user, revision, 'HEAD')
  console.log(`  fetched server history is ancestry of the person's HEAD: ${ancestry}`)

  // Capability control, part two, and it is deliberately contract-independent:
  // the fetch either delivered the revision into the checkout or it did not.
  // Keying this on an expected status instead would make the control assert
  // whichever contract is in force, so it would go quiet on the branch it most
  // needs to speak up about.
  const fetchedAfter = await gitOrNull(user, ['rev-parse', '--verify', FETCHED_REF])
  const capable = fetchedBefore === null && fetchedAfter === revision
  console.log(`  the fetch ran and delivered the revision: ${capable}`)

  return { label, capable, failed: violations.length > 0 || ancestry, violations, ancestry, status: result.status }
}

async function main() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tlda-user-territory-'))
  let failed = false
  let unreached = false
  try {
    // --- Negative control: the sync path is never invoked. --------------------
    console.log('NEGATIVE CONTROL: same fixture, the sync path never invoked')
    const control = await makeUserCheckout(root, 'control')
    const controlBefore = await snapshotUserTerritory(control)
    // Read-only work only. Nothing here may write, and that is the point.
    await git(control, ['status', '--porcelain'])
    await git(control, ['log', '--oneline', '-5'])
    const controlAfter = await snapshotUserTerritory(control)
    const controlViolations = diffUserTerritory(controlBefore, controlAfter)
    report(controlViolations)
    if (controlViolations.length > 0) {
      console.log('\nBROKEN HARNESS: the assertion reports writes when nothing ran.')
      console.log('Nothing below is a finding about the app.')
      process.exit(2)
    }
    console.log('  control passes: the instrument is quiet when nothing runs')

    const scenarios = [
      await scenario({
        root,
        label: 'A',
        title: 'an arrival that would merge cleanly — disjoint paths',
        serverFiles: { 'appendix.tex': 'a section only the server has\n' },
      }),
      await scenario({
        root,
        label: 'B',
        title: 'an arrival that would conflict — same path, different content',
        serverFiles: { 'main.tex': 'what the server thinks the paper says\n' },
      }),
      await scenario({
        root,
        label: 'C',
        title: 'the person had uncommitted work when the arrival landed',
        dirty: true,
        serverFiles: { 'appendix.tex': 'a section only the server has\n' },
      }),
    ]

    failed = scenarios.some(s => s.failed)
    unreached = scenarios.some(s => !s.capable)

    console.log('\n' + '='.repeat(72))
    for (const s of scenarios) {
      console.log(`  ${s.label}: ${s.failed ? 'WROTE USER TERRITORY' : 'left it alone'} (status ${s.status}${s.capable ? '' : ', FETCH DID NOT DELIVER'})`)
    }
    if (failed) {
      // A write is a finding whether or not every fixture was shown capable. An
      // undelivered fetch only weakens a scenario that found nothing.
      console.log('\nFAIL: the app wrote into territory the person owns.')
      console.log('Rule (relayed, not quoted): app/daemon never touches main; an explicitly')
      console.log('user-invoked relay owns merge-to-main and push.')
    } else if (unreached) {
      console.log('\nINCONCLUSIVE: a fixture found nothing and its fetch never delivered.')
    } else {
      console.log('\nPASS: the arrival path left user territory alone in every scenario.')
    }
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
  process.exit(failed ? 1 : unreached ? 2 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(3)
})
