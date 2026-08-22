#!/usr/bin/env node

/**
 * The app does not touch the branch the person is standing on.
 *
 * Skip, verbatim: "the app DOES NOT TOUCH MAIN EVER."
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
async function makeUserCheckout(root, label) {
  const dir = await fs.promises.mkdtemp(path.join(root, `user-${label}-`))
  await initRepo(dir)
  await write(path.join(dir, 'main.tex'), 'the authoritative work, already local\n')
  await git(dir, ['add', 'main.tex'])
  await git(dir, ['commit', '-m', 'the author writes their paper'])
  await write(path.join(dir, 'main.tex'), 'the authoritative work, already local, still being typed\n')
  await write(path.join(dir, 'scratch-notes.txt'), 'my own file, nothing to do with the paper\n')
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
async function scenario({ root, label, title, serverFiles, expectStatus }) {
  console.log(`\nSCENARIO ${label}: ${title}`)
  const user = await makeUserCheckout(root, label)
  const { dir: server, revision } = await makeFetchedRevision(root, label, serverFiles)
  await fetchInto(user, server, revision)

  const before = await snapshotUserTerritory(user)
  console.log(`  the person stands on ${before.symbolicHead} at ${before.head}`)
  console.log(`  the server's accepted revision is ${revision}`)

  const result = await makeSync(user).mirrorArrived(revision)
  console.log(`  mirrorArrived returned status=${result.status} ok=${result.ok}`)

  // Positive control on the input: every early return in mirrorArrived leaves
  // the checkout alone, so a run that never reached the merge would report a
  // clean pass while measuring nothing.
  if (result.status !== expectStatus) {
    console.log(`  FIXTURE DID NOT REACH THE PATH: expected status=${expectStatus}, got ${result.status}`)
    console.log('  Nothing in this scenario is a finding about the app.')
    return { reached: false, failed: false }
  }

  const after = await snapshotUserTerritory(user)
  const violations = diffUserTerritory(before, after)
  report(violations)

  const ancestry = await fetchedHistoryIsAncestry(user, revision, 'HEAD')
  console.log(`  fetched server history is ancestry of the person's HEAD: ${ancestry}`)

  const failed = violations.length > 0 || ancestry
  return { reached: true, failed, violations, ancestry }
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
    ]

    failed = scenarios.some(s => s.failed)
    unreached = scenarios.some(s => !s.reached)

    console.log('\n' + '='.repeat(72))
    if (unreached) {
      console.log('INCONCLUSIVE: a fixture did not reach the path it was built to exercise.')
    } else if (failed) {
      console.log('FAIL: the app wrote into territory the person owns.')
      console.log('Skip: "the app DOES NOT TOUCH MAIN EVER."')
    } else {
      console.log('PASS: mirrorArrived left user territory alone in both scenarios.')
    }
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
  process.exit(unreached ? 2 : failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(3)
})
