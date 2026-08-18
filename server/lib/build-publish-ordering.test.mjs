// A build that finishes after a newer one must not publish over it.
//
// Skip, 2026-08-18: "you just dont use a earlier build even if it ends later".
// He watched a line in his paper change from what he had just asked for back to
// its previous wording, and spent half an hour arguing with an agent that had
// done nothing wrong: the source was correct the whole time and the render went
// backwards underneath him.
//
// The per-project lock in runBuild serializes builds, which orders them by
// INVOCATION and not by source. A build started from an older accepted revision
// can still be the last one to reach the publish step, and the DVI publish was
// the one publish point with no ordering guard on it -- the sentinel
// (shouldSkipSentinelWrite) and the persistent build status both compare
// acceptSeq already. Publishing an older DVI also wipes the SVG cache, so every
// later page request re-renders older text and it stays wrong.
//
// This covers the comparison that decides it. readPublishedAcceptSeq is the
// disk half; the rule below is what the publish step asks of it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Both halves come from the module under test: a restated copy of the rule
// here would pass while the publish step did something else.
import { readPublishedAcceptSeq, isSupersededByPublished as isSuperseded } from './build-runner.mjs'

function withOutDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'publish-ordering-'))
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('the stamp reports what is currently published', () => {
  withOutDir(dir => {
    writeFileSync(join(dir, 'build.stamp'), '65')
    assert.equal(readPublishedAcceptSeq(dir), 65)
  })
})

test('no stamp reads as null, not 0 — 0 would discard the first build after a wipe', () => {
  withOutDir(dir => {
    assert.equal(readPublishedAcceptSeq(dir), null)
    // and null must not supersede anything
    assert.equal(isSuperseded(1, readPublishedAcceptSeq(dir)), false)
  })
})

test('an unreadable stamp reads as null rather than throwing mid-build', () => {
  withOutDir(dir => {
    writeFileSync(join(dir, 'build.stamp'), 'not-a-number')
    assert.equal(readPublishedAcceptSeq(dir), null)
  })
})

test('an older build that finishes later is discarded — the reported case', () => {
  withOutDir(dir => {
    writeFileSync(join(dir, 'build.stamp'), '65')
    assert.equal(isSuperseded(64, readPublishedAcceptSeq(dir)), true)
  })
})

test('a newer build publishes', () => {
  withOutDir(dir => {
    writeFileSync(join(dir, 'build.stamp'), '65')
    assert.equal(isSuperseded(66, readPublishedAcceptSeq(dir)), false)
  })
})

test('a rebuild of the same revision still publishes', () => {
  // Equal is not older. Rebuilding the same source must stay idempotent rather
  // than becoming a no-op -- a forced rebuild is how a corrupt render is fixed.
  withOutDir(dir => {
    writeFileSync(join(dir, 'build.stamp'), '65')
    assert.equal(isSuperseded(65, readPublishedAcceptSeq(dir)), false)
  })
})

test('a build with no acceptSeq always publishes', () => {
  // A manual or bootstrap build carries no accepted revision. Ranking it as 0
  // would make every one of them lose to any published build and silently do
  // nothing, which is the opposite of what asking for a rebuild means.
  withOutDir(dir => {
    writeFileSync(join(dir, 'build.stamp'), '65')
    assert.equal(isSuperseded(null, readPublishedAcceptSeq(dir)), false)
    assert.equal(isSuperseded(undefined, readPublishedAcceptSeq(dir)), false)
  })
})
