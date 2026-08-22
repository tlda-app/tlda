#!/usr/bin/env node

/**
 * Settle does not echo a proposal for a tree the server already has.
 *
 * `settle()` compares the tree it just committed against the shared one and
 * short-circuits with `equal-tree` when they match, submitting nothing. That
 * branch had exactly one test — `'accepted mirror with no local difference
 * produces no proposal echo'` in `daemon/git-project-mirror-unrelated.test.mjs`
 * — and it was retired when the accept path was deleted, because its premise
 * was that `headChanged` returns `merged`, which no longer happens.
 *
 * The premise died. The behaviour did not, and it became MORE load-bearing:
 * under parking the fetched ref is set and never merged in, so this comparison
 * is the only thing between a settle and a proposal duplicating what the server
 * already accepted. Previously a merge made the trees equal by construction.
 *
 * **This is not a red-on-`main` assertion and does not pretend to be one.** The
 * behaviour is correct on both `e2545ebea` and the parking branch; this is
 * coverage for live code that has none, not evidence of a defect. It is green
 * either side and its job is to fail if someone deletes the short-circuit.
 *
 * Written by the tester rather than the implementer, deliberately: the standing
 * rule in this lane is that a test written by whoever changed the behaviour
 * proves less, and this gap was found by reading tests the implementer rewrote.
 *
 * `daemon/git-project-sync.test.mjs` ALSO covers `equal-tree`, written from the
 * implementer's side and running inside the `node --test` suite. **Both are
 * deliberate and neither is duplication.** They do different jobs: that one is
 * where a future regression actually gets caught, because the suite runs on its
 * own; this one is the independent-authorship proof, and it additionally asserts
 * the remote rather than only the `onSubmitted` callback. Do not delete either
 * as redundant.
 *
 * They were written four minutes apart, neither author having seen the other's,
 * and both pass — which is a mutual check nobody designed. If `equal-tree` were
 * ambiguous about what it should do, that is where it would have shown.
 *
 * Run:  node bin/settle-does-not-echo-a-proposal-test.mjs
 */

import assert from 'assert/strict'
import { execFile as execFileCb } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { createGitProjectSync } from '../daemon/git-project-sync.mjs'

const execFileP = promisify(execFileCb)
const PROJECT = 'paper'

const git = (cwd, args) => execFileP('git', args, { cwd, timeout: 120000 })

async function initRepo(dir) {
  await git(dir, ['init', '-b', 'main'])
  await git(dir, ['config', 'user.name', 'fixture'])
  await git(dir, ['config', 'user.email', 'fixture@example.test'])
}

async function main() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tlda-settle-echo-'))
  try {
    const checkout = path.join(root, 'checkout')
    const remote = path.join(root, 'remote')
    await fs.promises.mkdir(checkout)
    await fs.promises.mkdir(remote)
    await initRepo(checkout)
    await initRepo(remote)

    // The person's tree already holds exactly what the server accepted. That is
    // the ordinary state after any successful round trip, which is why an echo
    // here would repeat on every settle rather than once.
    for (const dir of [checkout, remote]) {
      await fs.promises.writeFile(path.join(dir, 'main.tex'), 'same bytes\n')
      await git(dir, ['add', 'main.tex'])
      await git(dir, ['commit', '-m', 'paper'])
    }
    const revision = (await git(remote, ['rev-parse', 'HEAD'])).stdout.trim()
    await git(remote, ['update-ref', `refs/tlda/source/${PROJECT}`, revision])

    const submitted = []
    const sync = createGitProjectSync({
      sourceDir: checkout,
      project: PROJECT,
      daemonId: 'fixture-daemon',
      bindingId: 'fixture-binding',
      branch: 'main',
      remote,
      documentRoots: ['main.tex'],
      log: { info: () => {}, warn: () => {}, error: () => {} },
      onSubmitted: event => submitted.push(event),
    })

    // Capability control: the arrival has to have actually landed, or a later
    // "nothing was submitted" says only that nothing happened at all.
    const arrival = await sync.headChanged(revision)
    console.log(`  headChanged -> status=${arrival.status} ok=${arrival.ok}`)
    const fetched = (await git(checkout, ['rev-parse', `refs/tlda/fetched/${PROJECT}`])).stdout.trim()
    assert.equal(fetched, revision, 'the fixture never delivered the revision, so nothing below means anything')
    console.log(`  the shared revision is present at refs/tlda/fetched/${PROJECT}`)

    const settled = await sync.editClusterSettled()
    console.log(`  settle      -> status=${settled.status} ok=${settled.ok}`)

    assert.equal(settled.ok, true)
    assert.equal(settled.status, 'equal-tree', 'settle must short-circuit when the tree already matches the shared one')
    assert.equal(submitted.length, 0, 'no proposal may be submitted for a tree the server already has')

    // And nothing reached the remote, which is the fact the caller actually
    // cares about — onSubmitted not firing would be satisfied by a push that
    // simply forgot to call it.
    const proposals = (await git(remote, ['for-each-ref', '--format=%(refname)', 'refs/tlda/proposals'])).stdout.trim()
    assert.equal(proposals, '', 'no proposal ref may appear on the remote')
    console.log('  no proposal submitted, and no proposal ref on the remote')

    console.log('\nPASS: settle does not echo a proposal for a tree the server already has.')
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(`\nFAIL: ${e.message}`)
  console.error(e)
  process.exit(1)
})
