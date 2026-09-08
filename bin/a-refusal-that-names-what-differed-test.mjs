#!/usr/bin/env node
// A stale proposal must be refused without moving the accepted source ref.
// The refusal names both revisions and preserves the refused commit alongside
// the accepted history in a bundle the proposer can use for recovery/rebase.
// A descendant proposal still accepts and advances the source ref.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSourceGitStore } from '../server/lib/source-git-store.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-refusal-recovery-'))
const gitDir = join(root, 'source.git')
const bundlePath = join(root, 'refusal.bundle')
const project = 'refusal-recovery'

execFileSync('git', ['init', '--bare', '--quiet', gitDir])
const store = createSourceGitStore({ gitDir })

function assertRefusalContract(result) {
  assert.equal(result.ok, false, 'the stale proposal must be refused')
  assert.equal(result.status, 'non-fast-forward')
  assert.match(result.currentRevision || '', /^[0-9a-f]{40}$/, 'refusal must name currentRevision')
  assert.match(result.refusedRevision || '', /^[0-9a-f]{40}$/, 'refusal must name refusedRevision')
  assert.equal(result.recovery?.kind, 'bundle-rebase', 'refusal must name the bundle/rebase recovery path')
  assert.ok(result.recovery?.bundleBase64, 'refusal must carry a recoverable bundle')
}

async function admitProposal(proposed) {
  const decision = await store.fastForward(project, proposed)
  if (decision.ok) {
    return {
      ok: true,
      status: decision.status,
      currentRevision: decision.revision,
      previousRevision: decision.previous ?? null,
    }
  }

  const previousRefused = await store.refused(project)
  await store.markRefused(project, decision.proposed, previousRefused)
  return {
    ok: false,
    status: decision.status,
    currentRevision: decision.revision,
    refusedRevision: decision.proposed,
    recovery: {
      kind: 'bundle-rebase',
      bundleBase64: await store.bundleSince(project, decision.revision, {
        includeRefused: true,
        have: decision.proposed,
      }),
    },
  }
}

try {
  const base = await store.acceptRevision({
    project,
    files: [
      { path: 'main.tex', content: 'base main\n' },
      { path: 'intro.tex', content: 'base intro\n' },
    ],
  })
  const initial = await admitProposal(base)
  assert.equal(initial.ok, true)
  assert.equal(await store.head(project), base)

  const accepted = await store.acceptRevision({
    project,
    parent: base,
    files: [
      { path: 'main.tex', content: 'accepted main\n' },
      { path: 'intro.tex', content: 'base intro\n' },
    ],
  })
  const acceptedResult = await admitProposal(accepted)
  assert.equal(acceptedResult.ok, true)
  assert.equal(acceptedResult.currentRevision, accepted)

  const stale = await store.acceptRevision({
    project,
    parent: base,
    files: [
      { path: 'main.tex', content: 'stale main\n' },
      { path: 'intro.tex', content: 'stale intro\n' },
    ],
  })
  const refused = await admitProposal(stale)
  assertRefusalContract(refused)
  assert.equal(refused.currentRevision, accepted)
  assert.equal(refused.refusedRevision, stale)
  assert.equal(await store.head(project), accepted,
    'refusing a stale proposal must not move the accepted source ref')
  assert.equal(await store.refused(project), stale,
    'the refused commit must remain reachable through the refused ref')
  assert.equal((await store.readRevisionFile(stale, 'intro.tex')).toString(), 'stale intro\n',
    'the refused work must remain readable')

  writeFileSync(bundlePath, Buffer.from(refused.recovery.bundleBase64, 'base64'))
  execFileSync('git', ['--git-dir', gitDir, 'bundle', 'verify', bundlePath], { stdio: 'pipe' })
  const bundleHeads = execFileSync('git', ['bundle', 'list-heads', bundlePath], {
    encoding: 'utf8',
  })
  assert.match(bundleHeads, new RegExp(`${accepted}\\s+refs/tlda/source/${project}`),
    'the recovery bundle must carry the accepted source ref')
  assert.match(bundleHeads, new RegExp(`${stale}\\s+refs/tlda/refused/${project}`),
    'the recovery bundle must carry the refused commit')

  // Counterfactual: refusal alone is not enough. Removing recoverability must
  // make the contract check fail even though the non-fast-forward remains.
  assert.throws(
    () => assertRefusalContract({ ...refused, recovery: null }),
    /bundle\/rebase recovery path/,
  )
  assert.throws(
    () => assertRefusalContract({ ...refused, refusedRevision: null }),
    /refusal must name refusedRevision/,
  )

  const descendant = await store.acceptRevision({
    project,
    parent: accepted,
    files: [
      { path: 'main.tex', content: 'accepted main\n' },
      { path: 'intro.tex', content: 'descendant intro\n' },
    ],
  })
  const descendantResult = await admitProposal(descendant)
  assert.equal(descendantResult.ok, true)
  assert.equal(descendantResult.status, 'accepted')
  assert.equal(descendantResult.currentRevision, descendant)
  assert.equal(await store.head(project), descendant,
    'a descendant proposal must accept and move the source ref')
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('PASS stale refusal preserves both revisions and a recoverable bundle; descendant accepts')
