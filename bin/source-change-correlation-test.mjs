#!/usr/bin/env node
import assert from 'assert/strict'
import { createSourceChangeCorrelation } from '../daemon/source-sync.mjs'
import { createSourceChangeResultCache } from '../server/lib/source-change-correlation.mjs'

let nextId = 0
const warnings = []
const daemon = createSourceChangeCorrelation({ makeId: () => `request-${++nextId}`, log: { warn: message => warnings.push(message) } })
daemon.seed('paper', 'revision-1')
const first = daemon.prepare({ type: 'source-change', project: 'paper', files: [] })
assert.equal(first.requestId, 'request-1')
assert.equal(first.expectedRevision, 'revision-1')
assert.equal(daemon.handle({ requestId: 'wrong', project: 'paper', ok: true, sourceRevision: 'forged' }), false)
assert.equal(daemon.state('paper').revision, 'revision-1')
assert.equal(daemon.handle({ requestId: first.requestId, project: 'other', ok: true, sourceRevision: 'forged' }), false)
assert.equal(daemon.handle({ requestId: first.requestId, project: 'paper', ok: true, sourceRevision: 'revision-2' }), true)
assert.equal(daemon.state('paper').revision, 'revision-2')
assert.equal(daemon.handle({ requestId: first.requestId, project: 'paper', ok: true, sourceRevision: 'duplicate' }), false)

const stale = daemon.prepare({ type: 'source-change', project: 'paper', files: [] })
assert.equal(daemon.handle({ requestId: stale.requestId, project: 'paper', ok: false, status: 'stale-base' }), true)
assert.equal(daemon.state('paper').blocked, true)
assert.equal(daemon.prepare({ type: 'source-change', project: 'paper', files: [] }), null)
assert.equal(warnings.length, 1)

const server = createSourceChangeResultCache()
const request = { requestId: 'r1', project: 'paper', expectedRevision: 'revision-1', files: [], sourceManifest: [] }
const lookup = server.lookup(request)
assert.ok(lookup.hash)
const reply = { type: 'source-change-result', requestId: 'r1', project: 'paper', ok: true, sourceRevision: 'revision-2' }
server.record('r1', lookup.hash, reply)
assert.deepEqual(server.lookup(request).replay, reply)
assert.match(server.lookup({ ...request, files: [{ path: 'main.tex', content: 'different' }] }).error, /reused/)
assert.match(server.lookup({ ...request, requestId: '' }).error, /required/)

console.log('source change correlation tests passed')
