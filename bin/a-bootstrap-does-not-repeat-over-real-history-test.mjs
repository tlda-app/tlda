#!/usr/bin/env node
// The window this file protects is narrower than "does the ref move
// atomically" -- it is specifically bootstrap's, and it is not the same
// window bin/source-restart-mid-edit-test.mjs already covers.
//
// state() in source-lifecycle.mjs reconciles a stale authority.json against
// the live ref ONLY when the cached state says CURRENT:
//
//   async function state() {
//     const stored = readJson(statePath) || { state: UNINITIALIZED, ... }
//     if (stored.state !== SOURCE_AUTHORITY_CURRENT) return stored
//     const head = await sourceGit().head(project)
//     return head ? { ...stored, currentRevision: head } : stored
//   }
//
// bootstrap() is the one caller that runs while the cache is still
// UNINITIALIZED -- there is no prior authority.json to be stale, because
// there is no prior authority.json at all. If bootstrap's ref-move
// (advanceSourceHead) lands and the process dies before the FIRST
// authority.json write, the cache goes on reporting UNINITIALIZED forever:
// state()'s reconciliation branch never fires, because it only fires for
// CURRENT.
//
// The next caller through bootstrap() then sees `before.state ===
// UNINITIALIZED` -- exactly the precondition bootstrap requires to proceed --
// and bootstraps a SECOND time, with parent: null, on top of a project that
// already has real, accepted, ref-reachable history. That is not a crash
// losing unsaved work; it is a crash making a durable accept invisible to the
// one code path that is supposed to notice it happened.
//
// Uses the real fault hook (`createSourceLifecycleStore({fault})`), which
// atomicWrite already calls at 'before-rename' -- the same point a real crash
// would land at, between the ref move and the json rename -- rather than an
// injected throw inside application logic, so this proves the actual code
// path's ordering, not a mock of it.
import assert from 'assert/strict'
import { execFileSync } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { createSourceGitStore } from '../server/lib/source-git-store.mjs'
import { createSourceLifecycleStore } from '../server/lib/source-lifecycle.mjs'

function freshRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-bootstrap-repeat-'))
  const gitDir = join(dir, 'git')
  execFileSync('git', ['init', '--bare', '--quiet', gitDir])
  return dir
}

try {
  const root = freshRoot()

  // A fault that throws exactly once, only for the authority.json rename, so
  // the ref-move that already happened inside bootstrap() is real and
  // durable, and only the json write after it is interrupted.
  let armed = true
  const fault = (point, { path }) => {
    if (armed && point === 'before-rename' && path.endsWith('authority.json')) {
      armed = false
      throw new Error('simulated crash between ref-move and authority.json write')
    }
  }

  const crashingStore = createSourceLifecycleStore({ root, project: 'p', fault })
  await assert.rejects(
    () => crashingStore.bootstrap({
      expectedRevision: null,
      files: [{ path: 'main.tex', content: 'first accepted content\n' }],
      sourceManifest: ['main.tex'],
    }),
    /simulated crash/,
    'bootstrap — must actually throw here, or nothing below tests a crash at all',
  )

  // Ground truth: the ref already moved. bootstrap's persistSnapshot +
  // advanceSourceHead ran to completion before the injected fault fired.
  const gitStore = createSourceGitStore({ gitDir: join(root, 'git') })
  const firstHead = await gitStore.head('p')
  assert.notEqual(firstHead, null, 'the ref — bootstrap moved it before the crash; otherwise this is not the window under test')
  assert.equal(
    (await gitStore.readRevisionFile(firstHead, 'main.tex')).toString(),
    'first accepted content\n',
    'the ref — points at the real, durable, accepted first revision',
  )

  // A fresh store, as a restart would produce, with no fault this time.
  const restarted = createSourceLifecycleStore({ root, project: 'p' })
  const authority = await restarted.readAuthority()

  // The actual promise: a crash between the ref-move and the FIRST
  // authority.json write must not make the next bootstrap() call believe
  // there is no history to protect.
  assert.notEqual(
    authority.state, 'uninitialized',
    'the authority read after restart — must not report UNINITIALIZED when the ref already holds a real accepted revision; ' +
    'reporting UNINITIALIZED here is what lets the next bootstrap() run again and stack a second unrelated first-revision on top of real history',
  )
  assert.equal(authority.currentRevision, firstHead, 'the authority read — reconciles to the ref bootstrap actually advanced, not to a null/stale cache')

  // And the concrete failure this promise exists to prevent: bootstrap()
  // itself must refuse a second time now that state correctly reports
  // CURRENT, rather than silently accepting a disconnected second "first"
  // revision.
  await assert.rejects(
    () => restarted.bootstrap({
      expectedRevision: null,
      files: [{ path: 'main.tex', content: 'a second bootstrap that must not be allowed to happen\n' }],
      sourceManifest: ['main.tex'],
    }).then(result => {
      if (!result.ok) throw new Error(`bootstrap correctly refused: ${result.status}`)
      throw new Error('BOOTSTRAP SUCCEEDED A SECOND TIME -- this is the data-loss shape: real history is now behind a disconnected second root')
    }),
    /bootstrap correctly refused/,
    'a second bootstrap after restart — must be refused, not accepted over real history',
  )

  console.log('bootstrap does not repeat over real history: passed')
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
