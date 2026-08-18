#!/usr/bin/env node
// The window this file protects is bootstrap's specifically, and it is
// narrower than -- and different in shape from -- what
// bin/source-restart-mid-edit-test.mjs already covers.
//
// state() in source-lifecycle.mjs reconciles against the live ref whenever a
// ref exists at all (as of commit f0eda05b6, "Put the ref back when the
// record that follows it fails"):
//
//   async function state() {
//     const stored = readJson(statePath) || { state: UNINITIALIZED, ... }
//     if (stored.state === RECONCILIATION_REQUIRED) return stored
//     const head = await sourceGit().head(project)
//     if (!head) return stored
//     return { ...stored, state: CURRENT, currentRevision: head }
//   }
//
// That widened check (any ref, not only a cached CURRENT) is what closes the
// gap this file originally found: bootstrap's cache starts UNINITIALIZED
// (there is no prior authority.json to be stale), so the OLD narrower check
// (`if (stored.state !== CURRENT) return stored`) never reconciled bootstrap's
// own ref-move at all. f0eda05b6 also added a synchronous compensation path
// (recordAcceptedAuthority's try/catch, which retracts the ref if the
// authority.json write throws) -- but that path can only run in the SAME
// process, so it protects against a catchable failure, not against the
// process dying before it gets the chance to run at all.
//
// This file tests the case compensation cannot reach: the ref moves, durably,
// and the process is simply gone before anything -- compensation included --
// runs again. It builds that state by hand with the same low-level primitives
// bootstrap() itself uses (rather than injecting a catchable exception into
// bootstrap(), which would only exercise the try/catch, not the crash it is
// there to compensate for), then asks a FRESH store instance -- the shape a
// restart produces -- whether it reconciles correctly.
import assert from 'assert/strict'
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync } from 'fs'
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
  const gitDir = join(root, 'git')

  // The exact sequence bootstrap() runs, up to and including the ref move --
  // and stopping there, the way a process that died right after would.
  const store = createSourceGitStore({ gitDir })
  const firstHead = await store.acceptRevision({
    project: 'p',
    files: [{ path: 'main.tex', content: 'first accepted content\n' }],
  })
  await store.advanceHead('p', firstHead, null)
  // No authority.json write at all -- this IS the crash: bootstrap's cache
  // never gets its first write, the same as a process dying between
  // advanceSourceHead and recordAcceptedAuthority.

  assert.notEqual(firstHead, null, 'the ref — bootstrap-equivalent moved it; otherwise this is not the window under test')
  assert.equal(
    (await store.readRevisionFile(firstHead, 'main.tex')).toString(),
    'first accepted content\n',
    'the ref — points at the real, durable, accepted first revision',
  )

  // A fresh store, as a restart would produce: no fault, no prior
  // authority.json, exactly the "died before ever writing the cache" shape.
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
  assert.equal(authority.currentRevision, firstHead, 'the authority read — reconciles to the ref, not to a null/absent cache')

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
