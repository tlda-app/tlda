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
 * positive control too, on the input side: each scenario asserts that the path
 * actually reached its merge, because every early return in `mirrorArrived`
 * leaves user territory alone and would read as a pass.
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
 * The server's accepted revision, as a commit reachable in the person's
 * repository — which is where `fetchHead()` puts it before `mirrorArrived()`
 * runs. Fetched over a real remote, so the object arrives the way it does in
 * production rather than being constructed in place.
 */
async function makeFetchedRevision(root, label, files) {
  const server = await fs.promises.mkdtemp(path.join(root, `server-${label}-`))
  await initRepo(server)
  for (const [rel, content] of Object.entries(files)) await write(path.join(server, rel), content)
  await git(server, ['add', '-A'])
  await git(server, ['commit', '-m', 'server accepted a revision'])
  const { stdout } = await git(server, ['rev-parse', 'HEAD'])
  return { dir: server, revision: stdout.trim() }
}

async function fetchInto(userDir, serverDir, revision) {
  await git(userDir, ['fetch', '--no-tags', serverDir, `+${revision}:refs/tlda/fetched/${PROJECT}`])
}

function makeSync(sourceDir) {
  return createGitProjectSync({
    sourceDir,
    project: PROJECT,
    daemonId: 'fixture-daemon',
    bindingId: 'fixture-binding',
    branch: 'main',
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
async function scenario({ root, label, title, dirty = false, serverFiles, expectStatus }) {
  console.log(`\nSCENARIO ${label}: ${title}`)
  const user = await makeUserCheckout(root, label, { dirty })
  const { dir: server, revision } = await makeFetchedRevision(root, label, serverFiles)
  await fetchInto(user, server, revision)

  const before = await snapshotUserTerritory(user)
  console.log(`  the person stands on ${before.symbolicHead} at ${before.head}`)
  console.log(`  the server's accepted revision is ${revision}`)

  const result = await makeSync(user).mirrorArrived(revision)
  console.log(`  mirrorArrived returned status=${result.status} ok=${result.ok}`)

  // The territory measurement is unconditional. An earlier version of this test
  // returned here when the status was unexpected, and so never looked at the
  // checkout — which hid real writes behind a fixture note.
  const after = await snapshotUserTerritory(user)
  const violations = diffUserTerritory(before, after)
  report(violations)

  const ancestry = await fetchedHistoryIsAncestry(user, revision, 'HEAD')
  console.log(`  fetched server history is ancestry of the person's HEAD: ${ancestry}`)

  // Positive control on the input side, reported separately: every early return
  // in mirrorArrived reaches less of the path, so a scenario that finds nothing
  // and also did not reach its exit has established nothing either way.
  const reached = result.status === expectStatus
  if (!reached) console.log(`  NOTE: expected to exit at status=${expectStatus}, exited at ${result.status}`)

  return { label, reached, failed: violations.length > 0 || ancestry, violations, ancestry, status: result.status }
}

async function main() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tlda-user-territory-'))
  let failed = false
  let unreached = false
  try {
    // --- Negative control: the sync path is never invoked. --------------------
    console.log('NEGATIVE CONTROL: same fixture, mirrorArrived never invoked')
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
        title: 'the merge succeeds — server history joins the person\'s branch',
        // Disjoint paths, so an unrelated-histories merge resolves cleanly.
        serverFiles: { 'appendix.tex': 'a section only the server has\n' },
        expectStatus: 'merged',
      }),
      await scenario({
        root,
        label: 'B',
        title: 'the merge conflicts — the merge is left in progress in their checkout',
        // Same path, different content, so the same merge cannot resolve.
        serverFiles: { 'main.tex': 'what the server thinks the paper says\n' },
        expectStatus: 'conflicted',
      }),
      await scenario({
        root,
        label: 'C',
        title: 'the person had uncommitted work — line 219 commits it before anything else',
        dirty: true,
        serverFiles: { 'appendix.tex': 'a section only the server has\n' },
        // With a dirty checkout the path never reaches the merge: commitSettledTree
        // parents the new commit on the fetched ref, so the ancestry test at line
        // 229 then passes and the function reports the revision already applied.
        expectStatus: 'already-applied',
      }),
    ]

    failed = scenarios.some(s => s.failed)
    unreached = scenarios.some(s => !s.reached)

    console.log('\n' + '='.repeat(72))
    for (const s of scenarios) {
      console.log(`  ${s.label}: ${s.failed ? 'WROTE USER TERRITORY' : 'left it alone'} (exited at ${s.status}${s.reached ? '' : ', not the expected exit'})`)
    }
    if (failed) {
      // A write is a finding whether or not every scenario took the exit it was
      // built for. An unreached exit only weakens a scenario that found nothing.
      console.log('\nFAIL: the app wrote into territory the person owns.')
      console.log('Rule (relayed, not quoted): app/daemon never touches main; an explicitly')
      console.log('user-invoked relay owns merge-to-main and push.')
    } else if (unreached) {
      console.log('\nINCONCLUSIVE: a fixture found nothing and also did not reach its exit.')
    } else {
      console.log('\nPASS: mirrorArrived left user territory alone in every scenario.')
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
