#!/usr/bin/env node
import assert from 'assert/strict'
import { createSourceChangeCorrelation } from '../daemon/source-sync.mjs'

let nextId = 0
const warnings = []
const daemon = createSourceChangeCorrelation({ makeId: () => `request-${++nextId}`, log: { warn: message => warnings.push(message) } })
const first = daemon.prepare({ type: 'source-change', project: 'paper', expectedRevision: 'revision-1', files: [] })
assert.equal(first.requestId, 'request-1')
assert.equal(first.expectedRevision, 'revision-1')
assert.equal(daemon.handle({ requestId: 'wrong', project: 'paper', ok: true, sourceRevision: 'forged' }), false)
assert.equal(daemon.handle({ requestId: first.requestId, project: 'other', ok: true, sourceRevision: 'forged' }), false)
assert.equal(daemon.handle({ requestId: first.requestId, project: 'paper', ok: true, sourceRevision: 'revision-2' }), true)
assert.equal(daemon.handle({ requestId: first.requestId, project: 'paper', ok: true, sourceRevision: 'duplicate' }), false)

const rapidFirst = daemon.prepare({
  type: 'source-change',
  project: 'paper',
  expectedRevision: 'revision-2',
  files: [{ path: 'main.tex', content: 'first edit' }],
  sourceManifest: ['main.tex'],
})
assert.equal(rapidFirst.expectedRevision, 'revision-2')
assert.equal(daemon.prepare({
  type: 'source-change',
  project: 'paper',
  expectedRevision: 'revision-2',
  files: [{ path: 'main.tex', content: 'second edit' }],
  sourceManifest: ['main.tex'],
}), null, 'a second edit waits for the first source mutation')
assert.equal(daemon.state('paper').queued, true)
assert.equal(daemon.handle({
  requestId: rapidFirst.requestId,
  project: 'paper',
  ok: true,
  sourceRevision: 'revision-rapid-1',
}), true)
const rapidQueued = daemon.takeRetry()
assert.equal(rapidQueued.retried, false)
assert.deepEqual(rapidQueued.payload.files, [{ path: 'main.tex', content: 'second edit' }])
const rapidSecond = daemon.prepare(rapidQueued.payload, rapidQueued.retried)
assert.equal(rapidSecond.expectedRevision, 'revision-2')
assert.equal(daemon.handle({
  requestId: rapidSecond.requestId,
  project: 'paper',
  ok: true,
  sourceRevision: 'revision-rapid-2',
}), true)
const disconnected = daemon.prepare({
  type: 'source-change',
  project: 'paper',
  expectedRevision: 'revision-rapid-2',
  files: [{ path: 'main.tex', content: 'edit sent before disconnect' }],
})
assert.equal(daemon.prepare({
  type: 'source-change',
  project: 'paper',
  expectedRevision: 'revision-after-reconnect',
  files: [{ path: 'main.tex', content: 'edit made while disconnected' }],
}), null)
assert.equal(daemon.takeRetry(), null, 'without reconnect, a lost response wedges the queued edit')
daemon.beginReconnect()
assert.equal(daemon.state('paper').pending, false)
const [afterReconnect] = daemon.finishReconnect()
assert.deepEqual(afterReconnect.files, [{ path: 'main.tex', content: 'edit made while disconnected' }])
const resumed = daemon.prepare(afterReconnect)
assert.notEqual(resumed.requestId, disconnected.requestId, 'reconnect sends a fresh request')
assert.equal(resumed.expectedRevision, 'revision-after-reconnect')
assert.equal(daemon.handle({
  requestId: resumed.requestId,
  project: 'paper',
  ok: true,
  sourceRevision: 'revision-after-queued-edit',
}), true)

const lonePending = daemon.prepare({
  type: 'source-change',
  project: 'paper',
  expectedRevision: 'revision-after-queued-edit',
  files: [{ path: 'main.tex', content: 'only edit before reconnect' }],
})
daemon.beginReconnect()
const [loneAfterReconnect] = daemon.finishReconnect()
assert.equal(loneAfterReconnect, undefined, 'the in-flight edit is not duplicated into a fresh envelope')
daemon.restore(lonePending)
const loneResumed = lonePending
assert.equal(daemon.handle({
  requestId: loneResumed.requestId,
  project: 'paper',
  ok: true,
  sourceRevision: 'revision-after-lone-edit',
}), true)

const stale = daemon.prepare({ type: 'source-change', project: 'paper', files: [] })
assert.equal(daemon.handle({
  requestId: stale.requestId,
  project: 'paper',
  ok: false,
  status: 'stale-base',
  authority: { state: 'current', currentRevision: 'revision-3' },
}), true)
assert.equal(daemon.state('paper').blocked, false)
const retryPayload = daemon.takeRetry()
assert.deepEqual(retryPayload, {
  payload: { type: 'source-change', project: 'paper', files: [], expectedRevision: 'revision-3' },
  retried: true,
})
assert.equal(daemon.takeRetry(), null)
const retry = daemon.prepare(retryPayload.payload, retryPayload.retried)
assert.equal(retry.expectedRevision, 'revision-3')
assert.equal(daemon.handle({
  requestId: retry.requestId,
  project: 'paper',
  ok: false,
  status: 'stale-base',
  authority: { state: 'current', currentRevision: 'revision-4' },
}), true)
assert.equal(daemon.takeRetry(), null)
assert.equal(daemon.state('paper').blocked, true)
assert.equal(daemon.prepare({ type: 'source-change', project: 'paper', files: [] }), null)
assert.equal(daemon.state('paper').blocked, true)
daemon.holdForHuman('paper')
assert.equal(daemon.state('paper').blocked, false)

const laterEdit = daemon.prepare({
  type: 'source-change',
  project: 'paper',
  expectedRevision: 'revision-5',
  files: [{ path: 'main.tex', content: 'later edit' }],
})
assert.equal(laterEdit.expectedRevision, 'revision-5')
assert.deepEqual(laterEdit.files, [{ path: 'main.tex', content: 'later edit' }])

const unrecoverableStale = laterEdit
assert.equal(daemon.handle({ requestId: unrecoverableStale.requestId, project: 'paper', ok: false, status: 'stale-base' }), true)
assert.equal(daemon.state('paper').blocked, true)
assert.equal(daemon.prepare({ type: 'source-change', project: 'paper', files: [] }), null)
assert.equal(warnings.length, 3)
daemon.holdForHuman('paper')
assert.equal(daemon.state('paper').blocked, false)

const blockedRequest = daemon.prepare({ type: 'source-change', project: 'blocked-paper', expectedRevision: 'blocked-revision-1', files: [] })
assert.equal(daemon.handle({
  requestId: blockedRequest.requestId,
  project: 'blocked-paper',
  ok: false,
  status: 'stale-base',
}), true)
assert.equal(daemon.state('blocked-paper').blocked, true)
daemon.holdForHuman('blocked-paper')
assert.equal(daemon.state('blocked-paper').blocked, false, 'human conflict handoff releases a blocked project')
const afterUnblock = daemon.prepare({ type: 'source-change', project: 'blocked-paper', expectedRevision: 'blocked-revision-2', files: [] })
assert.ok(afterUnblock, 'the project can push again after the ordinary refresh')
assert.equal(afterUnblock.expectedRevision, 'blocked-revision-2')

console.log('source change correlation tests passed')
