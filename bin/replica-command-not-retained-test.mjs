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
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
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
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(failures === 0 ? 'PASS replica command not retained' : `FAIL replica command not retained (${failures})`)
process.exit(failures === 0 ? 0 : 1)
