#!/usr/bin/env node
import assert from 'assert/strict'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createSourceLifecycleStore, classifyThreeWay } from '../server/lib/source-lifecycle.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-source-lifecycle-'))
const snapshot = content => ({ expectedRevision: null, sourceManifest: ['main.tex'], files: [{ path: 'main.tex', content }] })
const store = createSourceLifecycleStore({ root, context: { format: 'svg', mainFile: 'main.tex' } })

assert.deepEqual(store.readAuthority(), { state: 'uninitialized', currentRevision: null })
assert.throws(() => store.bootstrap({ expectedRevision: null, sourceManifest: ['main.tex'], files: [] }), /exactly match/)
const first = store.bootstrap(snapshot('base\n'))
assert.equal(first.ok, true)
assert.equal(store.readRevision(first.authority.currentRevision).files[0].content, Buffer.from('base\n').toString('base64'))

const accepted = store.submit({ ...snapshot('current\n'), expectedRevision: first.authority.currentRevision })
assert.equal(accepted.ok, true)
const stale = store.submit({ ...snapshot('incoming\n'), expectedRevision: first.authority.currentRevision })
assert.equal(stale.status, 'stale-base')
assert.equal(store.readAuthority().currentRevision, accepted.authority.currentRevision)
assert.equal(store.readRevision(stale.evidence.incomingRevision).files[0].content, Buffer.from('incoming\n').toString('base64'))
assert.equal(stale.evidence.currentRevision, accepted.authority.currentRevision)
assert.equal(stale.evidence.classifications[0].status, 'conflict')

const pinRoot = mkdtempSync(join(tmpdir(), 'tlda-source-pins-'))
const pins = createSourceLifecycleStore({ root: pinRoot, context: { format: 'svg', mainFile: 'main.tex' } })
const pinA = pins.bootstrap({ ...snapshot('same\n'), dependencyPins: [{ version: '1', name: 'dep' }] })
const pinB = pins.submit({ ...snapshot('same\n'), expectedRevision: pinA.authority.currentRevision, dependencyPins: [{ name: 'dep', version: '2' }] })
assert.notEqual(pinA.authority.currentRevision, pinB.authority.currentRevision)
assert.deepEqual(pinA.revision, pins.readRevision(pinA.authority.currentRevision))
assert.deepEqual(pinB.revision, pins.readRevision(pinB.authority.currentRevision))
assert.deepEqual(pinB.revision.dependencyPins, [{ name: 'dep', version: '2' }])

const clean = classifyThreeWay({ base: 'a\nkeep-1\nkeep-2\nb\n', current: 'A\nkeep-1\nkeep-2\nb\n', incoming: 'a\nkeep-1\nkeep-2\nB\n' })
assert.equal(clean.status, 'clean-rebase-candidate')
const conflict = classifyThreeWay({ base: 'a\n', current: 'ours\n', incoming: 'theirs\n' })
assert.equal(conflict.status, 'conflict')
assert.match(conflict.merged, /<<<<<<<|>>>>>>>/)
assert.equal(classifyThreeWay({ base: null, current: 'a', incoming: 'b' }).status, 'classification-unavailable')
assert.equal(classifyThreeWay({ base: 'a', current: 'b', incoming: 'c', binary: true }).status, 'classification-unavailable')

const reconcileRoot = mkdtempSync(join(tmpdir(), 'tlda-source-reconcile-'))
const reconcile = createSourceLifecycleStore({ root: reconcileRoot, context: { format: 'svg', mainFile: 'main.tex' } })
const held = reconcile.bootstrap({ ...snapshot('proposed\n'), observedServerFiles: [{ path: 'main.tex', content: 'existing\n' }] })
assert.equal(held.status, 'reconciliation-required')
assert.equal(reconcile.readAuthority().currentRevision, null)
assert.equal(reconcile.readRevision(held.authority.evidenceRevision).files[0].content, Buffer.from('existing\n').toString('base64'))

const crashRoot = mkdtempSync(join(tmpdir(), 'tlda-source-crash-'))
const crashing = createSourceLifecycleStore({ root: crashRoot, context: { format: 'svg', mainFile: 'main.tex' }, fault(stage) { if (stage === 'before-rename') throw new Error('injected crash') } })
assert.throws(() => crashing.bootstrap(snapshot('never-current\n')), /injected crash/)
assert.deepEqual(crashing.readAuthority(), { state: 'uninitialized', currentRevision: null })

const authorityJson = readFileSync(join(root, 'authority.json'), 'utf8')
assert.doesNotMatch(authorityJson, /expires|retention|deleteAfter|quota/i)
console.log('source lifecycle authority tests passed')
