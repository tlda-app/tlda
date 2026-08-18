#!/usr/bin/env node
// A settled replica must not retain its command payload.
//
// `command` carries `blobs` — base64 of every changed file — so that the
// fan-out in unified-server.mjs can re-send it. That path filters on
// `state === 'pending'`, so the payload is unreachable the moment the replica
// settles. It was being kept anyway, forever, per revision, per binding.
//
// Measured on the live volume 2026-08-17: bregman's lifecycle journal was
// 95.6 MB, `revisionLifecycle` 82 MB of it across 22 revisions, and in the
// largest revision record `command` was 54,374,893 of 54,376,465 bytes —
// 99.998%. `GET /api/projects` reads that journal in full, synchronously, for
// every project, on every request.
//
// So this asserts two things that must both hold: a PENDING replica keeps its
// command (or the retry cannot fire), and a SETTLED one does not (or the
// journal grows without bound).
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createSourceLifecycleStore } from '../server/lib/source-lifecycle.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-replica-command-'))
let failures = 0
const check = (label, fn) => {
  try {
    fn()
    console.log(`  ok   ${label}`)
  } catch (e) {
    failures++
    console.error(`  FAIL ${label}: ${e.message}`)
  }
}

try {
  const store = createSourceLifecycleStore({ root, context: { referencedRoots: ['main.tex'] } })
  const project = 'paper'
  const bootstrap = store.bootstrap({
    expectedRevision: null,
    files: [{ path: 'main.tex', content: 'one\n' }],
    sourceManifest: ['main.tex'],
  })
  assert.equal(bootstrap.ok, true, 'bootstrap must succeed')
  const revision = bootstrap.authority.currentRevision
  // Replicas attach to an ACCEPTED revision; bootstrap alone does not create the
  // lifecycle row they hang off.
  store.recordAcceptedRevision(project, revision, 1)

  // A command the size of a real one: blobs is where the bytes live.
  const bigBlob = 'A'.repeat(2 * 1024 * 1024)
  store.recordReplicaTargets(project, revision, [{ bindingId: 'binding-1', daemonKey: 'mini:testing' }], {
    project,
    blobs: { 'sha256:aaa': bigBlob },
    baseManifest: [], targetManifest: [],
  })

  const journalPath = join(root, 'operations.json')
  const sizeWhilePending = readFileSync(journalPath, 'utf8').length

  check('a PENDING replica keeps its command, or the retry cannot fire', () => {
    const replica = store.readRevisionLifecycle(project, revision).replicas['binding-1']
    assert.equal(replica.state, 'pending')
    assert.ok(replica.command, 'pending replica must retain command')
    assert.ok(replica.command.blobs, 'the retry needs the blobs')
  })

  store.recordReplicaResult(project, revision, 'binding-1', 'materialized', { ok: true })

  check('a SETTLED replica drops its command', () => {
    const replica = store.readRevisionLifecycle(project, revision).replicas['binding-1']
    assert.equal(replica.state, 'materialized')
    assert.equal(replica.command, undefined, 'settled replica must not retain the payload')
  })

  check('the settled record keeps everything that is not the payload', () => {
    const replica = store.readRevisionLifecycle(project, revision).replicas['binding-1']
    assert.equal(replica.daemonKey, 'mini:testing')
    assert.equal(replica.operationId, `materialize:binding-1:${revision}`)
    assert.deepEqual(replica.result, { ok: true })
    assert.ok(replica.updatedAt)
  })

  check('the journal shrinks by about the payload, on disk', () => {
    const sizeAfter = readFileSync(journalPath, 'utf8').length
    assert.ok(sizeWhilePending > 2_000_000, `expected a large pending journal, got ${sizeWhilePending}`)
    assert.ok(sizeAfter < 100_000,
      `settled journal should be small; it is ${sizeAfter} bytes (was ${sizeWhilePending})`)
  })

  check('a failed replica also drops it — terminal is terminal', () => {
    store.recordReplicaTargets(project, revision, [{ bindingId: 'binding-2', daemonKey: 'mini:other' }], {
      project, blobs: { 'sha256:bbb': bigBlob }, baseManifest: [], targetManifest: [],
    })
    store.recordReplicaResult(project, revision, 'binding-2', 'failed', { ok: false, error: 'daemon gone' })
    const replica = store.readRevisionLifecycle(project, revision).replicas['binding-2']
    assert.equal(replica.state, 'failed')
    assert.equal(replica.command, undefined, 'a failed replica is not re-sent from the journal either')
  })
  // Expiry. A pending replica whose daemon never answers pins its payload
  // forever, and the payload is base64 of every changed file. On 2026-08-17 one
  // such replica -- pending since 06:55 that morning -- held 54,374,893 bytes,
  // 42% of every lifecycle journal on the box, re-read by every project-list
  // request and re-sent on every fan-out.
  //
  // The boundary matters in BOTH directions: expire too eagerly and a live
  // retry is killed while its daemon is merely reconnecting.
  check('a recently-pending replica is NOT expired', () => {
    const store2 = createSourceLifecycleStore({ root: mkdtempSync(join(tmpdir(), 'tlda-exp-a-')), context: { referencedRoots: ['main.tex'] } })
    const b = store2.bootstrap({ expectedRevision: null, files: [{ path: 'main.tex', content: 'x\n' }], sourceManifest: ['main.tex'] })
    const rev = b.authority.currentRevision
    store2.recordAcceptedRevision(project, rev, 1)
    store2.recordReplicaTargets(project, rev, [{ bindingId: 'fresh', daemonKey: 'mini:testing' }], { project, blobs: { a: 'x' } })
    // A second accepted revision drives the expiry sweep.
    const b2 = store2.submit({ expectedRevision: rev, files: [{ path: 'main.tex', content: 'y\n' }], sourceManifest: ['main.tex'] })
    if (b2?.ok) {
      store2.recordAcceptedRevision(project, b2.authority.currentRevision, 2)
      store2.recordReplicaTargets(project, b2.authority.currentRevision, [{ bindingId: 'other', daemonKey: 'mini:testing' }], { project, blobs: { a: 'x' } })
    }
    const replica = store2.readRevisionLifecycle(project, rev).replicas.fresh
    assert.equal(replica.state, 'pending', 'a replica pending for seconds must stay pending')
    assert.ok(replica.command, 'and must keep its payload, or a reconnecting daemon loses its retry')
  })

  check('a long-pending replica is expired and loses its payload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tlda-exp-b-'))
    const store3 = createSourceLifecycleStore({ root: dir, context: { referencedRoots: ['main.tex'] } })
    const b = store3.bootstrap({ expectedRevision: null, files: [{ path: 'main.tex', content: 'x\n' }], sourceManifest: ['main.tex'] })
    const rev = b.authority.currentRevision
    store3.recordAcceptedRevision(project, rev, 1)
    store3.recordReplicaTargets(project, rev, [{ bindingId: 'stuck', daemonKey: 'mini:testing' }], { project, blobs: { big: 'A'.repeat(1024) } })

    // Age it on disk, the way seventeen hours would.
    const jp = join(dir, 'operations.json')
    const j = JSON.parse(readFileSync(jp, 'utf8'))
    // Age the REVISION, and deliberately leave the replica's updatedAt fresh --
    // that is exactly the live shape: the fan-out re-sends a stuck replica and
    // refreshes its updatedAt every time, so ageing on updatedAt reclaims
    // nothing. Measured against the live volume 2026-08-18.
    j.revisionLifecycle[rev].acceptedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
    j.revisionLifecycle[rev].replicas.stuck.updatedAt = new Date().toISOString()
    writeFileSync(jp, JSON.stringify(j))

    const store4 = createSourceLifecycleStore({ root: dir, context: { referencedRoots: ['main.tex'] } })
    const b2 = store4.submit({ expectedRevision: rev, files: [{ path: 'main.tex', content: 'z\n' }], sourceManifest: ['main.tex'] })
    assert.ok(b2?.ok, 'second submit must be accepted to drive the sweep')
    store4.recordAcceptedRevision(project, b2.authority.currentRevision, 2)
    store4.recordReplicaTargets(project, b2.authority.currentRevision, [{ bindingId: 'other', daemonKey: 'mini:testing' }], { project, blobs: { a: 'x' } })

    const replica = store4.readRevisionLifecycle(project, rev).replicas.stuck
    assert.equal(replica.state, 'expired', 'a replica pending past the cutoff must go terminal')
    assert.equal(replica.command, undefined, 'and must lose its payload')
    assert.equal(replica.daemonKey, 'mini:testing', 'while keeping what it was')
    assert.match(replica.result.error, /re-materialise/, 'and saying how to recover')
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? 'PASS replica command not retained' : `FAIL replica command not retained (${failures})`)
process.exit(failures === 0 ? 0 : 1)
