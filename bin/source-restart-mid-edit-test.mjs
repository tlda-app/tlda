#!/usr/bin/env node
// A restart in the middle of an accept, under the git-backed source store.
//
// The old dangerous window was snapshot -> write bytes to disk -> record a
// revision, with disk itself as the place a reader could see half-written
// content. That window does not exist in this mechanism, and not because
// nobody has hit it yet -- it is structurally gone:
//
//   - `acceptRevision` (server/lib/source-git-store.mjs) writes durable,
//     content-addressed git objects (a blob per file, then a tree, then a
//     commit) and touches no ref. A crash here leaves real bytes on disk, but
//     nothing a reader consults can find them: `head()` still answers with
//     whatever it answered before. There is no state to diverge from, because
//     nothing has been published.
//   - Publishing is `advanceHead`, a single atomic compare-and-swap on a ref.
//     Either it lands whole or it does not land, so there is no half-applied
//     ref state to crash into.
//
// So the promise this file protects -- a process that dies mid-accept does
// not lose the work, and disk/authority do not diverge -- moves to a
// narrower, later window: every real caller (`bootstrap`, `submit`,
// `acceptBundle` in server/lib/source-lifecycle.mjs) advances the ref and
// only THEN writes `authority.json`, a local cache of the state name and
// acceptSeq. A crash between those two steps leaves the cache stale.
//
// source-lifecycle.mjs's own `state()` names this exact window in its doc
// comment and defuses it by construction: whenever the cached state says
// CURRENT, `state()` re-derives `currentRevision` from the live ref rather
// than trusting the cached value. A stale cache after a crash there is
// self-healing on the next read, not lossy. This file proves that directly,
// against the real `readAuthority()` (== `state()`), rather than assuming the
// doc comment is still true.
//
// Both crashes below are real SIGKILLs of a real child process, not injected
// throws -- a throw runs the rollback the code already has; a restart does
// not, and recovering without one is the thing under test. The child calls
// the same exported git-store primitives the real callers use
// (`acceptRevision`, `advanceHead`), in the same order, with the kill placed
// by hand between them -- the same reason the previous version of this file
// drove `writeSourceFileAsync` directly rather than calling
// `processProjectPush` and hoping to interrupt it mid-body: a black-box async
// call cannot be reliably killed at a specific internal step from outside it.
//
// What has no analog here and is not tested below: the old file's
// journal-then-files split (`simulateCrashAfterJournal`). There is no
// separate journal step in this mechanism -- the commit is the one and only
// durable write, so there is nothing "after the journal, before the files"
// to crash between.
import assert from 'assert/strict'
import { execFileSync } from 'child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { createSourceGitStore } from '../server/lib/source-git-store.mjs'
import { createSourceLifecycleStore } from '../server/lib/source-lifecycle.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const gitStoreModule = join(repoRoot, 'server/lib/source-git-store.mjs')

function freshRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-source-restart-'))
  const gitDir = join(dir, 'git')
  execFileSync('git', ['init', '--bare', '--quiet', gitDir])
  return dir
}

function runChildToDeath(childPath, source) {
  writeFileSync(childPath, source)
  try {
    execFileSync(process.execPath, [childPath], { stdio: 'pipe' })
    return false
  } catch (error) {
    return error.signal === 'SIGKILL'
  }
}

try {
  // ## A crash before the ref moves leaves nothing current
  //
  // `acceptRevision` writes real git objects and returns a commit sha that
  // touches no ref. If the process dies right there, that commit is real and
  // on disk but unreachable from anything a reader consults.
  {
    const root = freshRoot()
    const gitDir = join(root, 'git')

    const died = runChildToDeath(join(root, 'crash-before-ref.mjs'), `
import { createSourceGitStore } from ${JSON.stringify(gitStoreModule)}
const store = createSourceGitStore({ gitDir: ${JSON.stringify(gitDir)} })
await store.acceptRevision({ project: 'p', files: [{ path: 'main.tex', content: 'half-written main\\n' }] })
process.kill(process.pid, 'SIGKILL')
`)
    assert.equal(died, true, 'the accept — dies after writing the commit but before moving the ref; otherwise nothing below tests a crash at all')

    const store = createSourceGitStore({ gitDir })
    assert.equal(await store.head('p'), null, 'the ref — was never moved by the killed accept, so nothing is current that was not accepted')

    // A retry lands cleanly. The dangling commit from the killed attempt is
    // orphaned — reachable from nothing — and neither blocks nor corrupts a
    // fresh accept.
    const id = await store.acceptRevision({ project: 'p', files: [{ path: 'main.tex', content: 'retried main\n' }] })
    await store.advanceHead('p', id, null)
    assert.equal(await store.head('p'), id, 'the retry — accepts cleanly after the killed attempt')
    assert.equal(
      (await store.readRevisionFile(id, 'main.tex')).toString(), 'retried main\n',
      'the retried content — is what is actually current, not the half-written attempt',
    )
  }

  // ## A crash after the ref moves, before the authority cache catches up
  //
  // This is the real remaining window, and it is the one `state()` in
  // source-lifecycle.mjs is documented to defuse: the ref already names the
  // new revision, the cache still names the old one, and reading "what is
  // current" through the real production path must side with the ref.
  {
    const root = freshRoot()
    const gitDir = join(root, 'git')
    const statePath = join(root, 'authority.json')

    const store = createSourceGitStore({ gitDir })
    const base = await store.acceptRevision({ project: 'p', files: [{ path: 'main.tex', content: 'base main\n' }] })
    await store.advanceHead('p', base, null)
    writeFileSync(statePath, JSON.stringify({ state: 'current', currentRevision: base, acceptSeq: 1 }))

    const died = runChildToDeath(join(root, 'crash-after-ref.mjs'), `
import { createSourceGitStore } from ${JSON.stringify(gitStoreModule)}
const store = createSourceGitStore({ gitDir: ${JSON.stringify(gitDir)} })
const id = await store.acceptRevision({ project: 'p', parent: ${JSON.stringify(base)}, files: [{ path: 'main.tex', content: 'after restart main\\n' }] })
await store.advanceHead('p', id, ${JSON.stringify(base)})
process.kill(process.pid, 'SIGKILL')
`)
    assert.equal(died, true, 'the accept — dies after moving the ref but before the authority cache is rewritten; otherwise nothing below tests a crash at all')

    // Ground truth already agrees with the new content — the ref is not what
    // needs recovering.
    const newHead = await store.head('p')
    assert.notEqual(newHead, base, 'the ref — advanced to the new revision before the crash')

    // The cache is provably stale: the crash landed before it was rewritten.
    const staleCache = JSON.parse(readFileSync(statePath, 'utf8'))
    assert.equal(staleCache.currentRevision, base, 'the authority cache — was not reached by the crash, still names the old revision')

    // The actual promise: reading "what is current" through the real
    // production entry point (`readAuthority`, i.e. `state()`) must report
    // the new revision despite the stale cache, not the old one.
    const lifecycle = createSourceLifecycleStore({ root, project: 'p' })
    const authority = await lifecycle.readAuthority()
    assert.equal(authority.currentRevision, newHead, 'the authority read — reconciles against the live ref, not the stale cache')
    assert.equal(
      (await store.readRevisionFile(authority.currentRevision, 'main.tex')).toString(), 'after restart main\n',
      'the reconciled content — is the post-restart save, not the pre-crash base',
    )

    // And the project is not wedged: a normal accept afterward still works.
    const again = await store.acceptRevision({ project: 'p', parent: newHead, files: [{ path: 'main.tex', content: 'after reconciliation\n' }] })
    await store.advanceHead('p', again, newHead)
    assert.equal(await store.head('p'), again, "a save after reconciliation — is accepted normally")
  }

  console.log('source restart mid-edit tests passed')
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
