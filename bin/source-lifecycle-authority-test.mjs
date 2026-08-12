#!/usr/bin/env node
import assert from 'assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
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
assert.equal(store.readRevisionFile(first.authority.currentRevision, 'main.tex').toString(), 'base\n')

// A revision id is a hash of its (path, content hash) tree, so it is stable for
// the same content, sensitive to any file's content, and cheap enough to compute
// that a push does not read the project. It is NOT the id the pre-blob-store
// definition produced -- that one hashed concatenated content -- and the three
// properties below are what actually has to hold.
assert.match(first.authority.currentRevision, /^sha256:[0-9a-f]{64}$/)

const accepted = store.submit({ ...snapshot('current\n'), expectedRevision: first.authority.currentRevision })
assert.equal(accepted.ok, true)
const stale = store.submit({ ...snapshot('incoming\n'), expectedRevision: first.authority.currentRevision })
assert.equal(stale.status, 'stale-base')
assert.equal(store.readAuthority().currentRevision, accepted.authority.currentRevision)
assert.equal(store.readRevisionFile(stale.evidence.incomingRevision, 'main.tex').toString(), 'incoming\n')
assert.equal(stale.evidence.currentRevision, accepted.authority.currentRevision)
assert.equal(stale.evidence.classifications[0].status, 'conflict')

const cleanRoot = mkdtempSync(join(tmpdir(), 'tlda-source-clean-rebase-'))
const cleanStore = createSourceLifecycleStore({ root: cleanRoot, context: { format: 'svg', mainFile: 'main.tex' } })
const cleanBase = cleanStore.bootstrap({
  expectedRevision: null,
  sourceManifest: ['main.tex', 'notes.tex'],
  files: [
    { path: 'main.tex', content: 'base main\n' },
    { path: 'notes.tex', content: 'base notes\n' },
  ],
})
const cleanCurrent = cleanStore.submit({
  expectedRevision: cleanBase.authority.currentRevision,
  sourceManifest: ['main.tex', 'notes.tex'],
  files: [
    { path: 'main.tex', content: 'alice main\n' },
    { path: 'notes.tex', content: 'base notes\n' },
  ],
})
const cleanStale = cleanStore.submit({
  expectedRevision: cleanBase.authority.currentRevision,
  sourceManifest: ['main.tex', 'notes.tex'],
  files: [
    { path: 'main.tex', content: 'base main\n' },
    { path: 'notes.tex', content: 'bob notes\n' },
  ],
})
assert.equal(cleanStale.ok, true)
assert.equal(cleanStale.status, 'accepted-clean-rebase')
assert.equal(cleanStale.evidence.classifications.every(item => item.status === 'clean-rebase-candidate'), true)
assert.equal(cleanStore.readAuthority().currentRevision, cleanStale.authority.currentRevision)
assert.deepEqual(
  cleanStore.readRevision(cleanStale.authority.currentRevision).manifest.map(
    path => [path, cleanStore.readRevisionFile(cleanStale.authority.currentRevision, path).toString()],
  ),
  [['main.tex', 'alice main\n'], ['notes.tex', 'bob notes\n']],
)

const pinRoot = mkdtempSync(join(tmpdir(), 'tlda-source-pins-'))
const pins = createSourceLifecycleStore({ root: pinRoot, context: { format: 'svg', mainFile: 'main.tex' } })
const pinA = pins.bootstrap({ ...snapshot('same\n'), dependencyPins: [{ version: '1', name: 'dep' }] })
const pinB = pins.submit({ ...snapshot('same\n'), expectedRevision: pinA.authority.currentRevision, dependencyPins: [{ name: 'dep', version: '2' }] })
assert.notEqual(pinA.authority.currentRevision, pinB.authority.currentRevision)
assert.deepEqual(pinA.revision, pins.readRevision(pinA.authority.currentRevision))
assert.deepEqual(pinB.revision, pins.readRevision(pinB.authority.currentRevision))
assert.deepEqual(pinB.revision.dependencyPins, [{ name: 'dep', version: '2' }])

// Same content, independent store: same id. Different content in one file of
// many: different id. A `version: 1` snapshot already on disk stays readable at
// the id it was written under, which is what lets live projects keep their
// current revision instead of being migrated.
const idRootA = mkdtempSync(join(tmpdir(), 'tlda-source-id-a-'))
const idRootB = mkdtempSync(join(tmpdir(), 'tlda-source-id-b-'))
const twoFiles = content => ({
  expectedRevision: null,
  sourceManifest: ['main.tex', 'notes.tex'],
  files: [{ path: 'main.tex', content: 'shared\n' }, { path: 'notes.tex', content }],
})
const idA = createSourceLifecycleStore({ root: idRootA, context: { format: 'svg', mainFile: 'main.tex' } }).bootstrap(twoFiles('same\n'))
const idB = createSourceLifecycleStore({ root: idRootB, context: { format: 'svg', mainFile: 'main.tex' } }).bootstrap(twoFiles('same\n'))
assert.equal(idA.authority.currentRevision, idB.authority.currentRevision)
const idRootC = mkdtempSync(join(tmpdir(), 'tlda-source-id-c-'))
const idC = createSourceLifecycleStore({ root: idRootC, context: { format: 'svg', mainFile: 'main.tex' } }).bootstrap(twoFiles('different\n'))
assert.notEqual(idA.authority.currentRevision, idC.authority.currentRevision)

const legacyRoot = mkdtempSync(join(tmpdir(), 'tlda-source-legacy-'))
const legacyId = 'sha256:0dde802a3954a4eec8cccee9cd6d46961401b6edcf8946fc87beb2d8f41b35e0'
mkdirSync(join(legacyRoot, 'revisions', encodeURIComponent(legacyId)), { recursive: true })
writeFileSync(join(legacyRoot, 'revisions', encodeURIComponent(legacyId), 'snapshot.json'), JSON.stringify({
  version: 1, id: legacyId, manifest: ['main.tex'],
  files: [{ path: 'main.tex', content: Buffer.from('base\n').toString('base64') }],
  byteSize: 5, dependencyPins: [], createdAt: '2026-07-22T12:15:15.000Z',
}))
writeFileSync(join(legacyRoot, 'authority.json'), JSON.stringify({ state: 'current', currentRevision: legacyId }))
const legacy = createSourceLifecycleStore({ root: legacyRoot, context: { format: 'svg', mainFile: 'main.tex' } })
assert.equal(legacy.readCurrentFile('main.tex').content.toString(), 'base\n')
assert.equal(legacy.readRevisionFile(legacyId, 'main.tex').toString(), 'base\n')
// And a push on top of it carries the inline file forward into a blob revision.
const afterLegacy = legacy.submit({
  expectedRevision: legacyId,
  sourceManifest: ['added.tex', 'main.tex'],
  files: [
    { path: 'added.tex', content: Buffer.from('added\n').toString('base64'), encoding: 'base64' },
    legacy.readRevision(legacyId).files[0],
  ],
})
assert.equal(afterLegacy.ok, true)
assert.equal(legacy.readRevisionFile(afterLegacy.authority.currentRevision, 'main.tex').toString(), 'base\n')
assert.equal(legacy.readRevisionFile(afterLegacy.authority.currentRevision, 'added.tex').toString(), 'added\n')

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
assert.equal(reconcile.readRevisionFile(held.authority.evidenceRevision, 'main.tex').toString(), 'existing\n')

const partialRoot = mkdtempSync(join(tmpdir(), 'tlda-source-partial-'))
const partial = createSourceLifecycleStore({ root: partialRoot, context: { format: 'svg', mainFile: 'main.tex' } })
const partialHeld = partial.bootstrap({
  expectedRevision: null,
  sourceManifest: ['main.tex', 'notes.tex'],
  files: [{ path: 'main.tex', content: 'proposed\n' }, { path: 'notes.tex', content: 'notes\n' }],
  observedSourceManifest: ['main.tex'],
  observedServerFiles: [{ path: 'main.tex', content: 'proposed\n' }],
})
assert.equal(partialHeld.status, 'reconciliation-required')
assert.deepEqual(partial.readRevision(partialHeld.authority.evidenceRevision).manifest, ['main.tex'])

const crashRoot = mkdtempSync(join(tmpdir(), 'tlda-source-crash-'))
const crashing = createSourceLifecycleStore({ root: crashRoot, context: { format: 'svg', mainFile: 'main.tex' }, fault(stage) { if (stage === 'before-rename') throw new Error('injected crash') } })
assert.throws(() => crashing.bootstrap(snapshot('never-current\n')), /injected crash/)
assert.deepEqual(crashing.readAuthority(), { state: 'uninitialized', currentRevision: null })

const authorityJson = readFileSync(join(root, 'authority.json'), 'utf8')
assert.doesNotMatch(authorityJson, /expires|retention|deleteAfter|quota/i)
console.log('source lifecycle authority tests passed')
