#!/usr/bin/env node
import assert from 'assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createSourceLifecycleStore, classifyThreeWay } from '../server/lib/source-lifecycle.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-source-lifecycle-'))
const snapshot = content => ({ expectedRevision: null, sourceManifest: ['main.tex'], files: [{ path: 'main.tex', content }] })
const store = createSourceLifecycleStore({ root, context: { format: 'svg', mainFile: 'main.tex' } })

assert.deepEqual(await store.readAuthority(), { state: 'uninitialized', currentRevision: null, acceptSeq: 0 })
await assert.rejects(() => store.bootstrap({ expectedRevision: null, sourceManifest: ['main.tex'], files: [] }), /exactly match/)
const first = await store.bootstrap(snapshot('base\n'))
assert.equal(first.ok, true)
assert.equal((await store.readRevisionFile(first.authority.currentRevision, 'main.tex')).toString(), 'base\n')

// A revision id is a COMMIT sha. It is not a function of the content alone, and
// that is the change: a commit carries when it happened and what it followed, so
// the same bytes accepted twice are two revisions. That is what makes the ids a
// history rather than a set, which is the thing being mirrored into the author's
// checkout.
assert.match(first.authority.currentRevision, /^[0-9a-f]{40}$/)

const accepted = await store.submit({ ...snapshot('current\n'), expectedRevision: first.authority.currentRevision })
assert.equal(accepted.ok, true)
// The accepted revision descends from the one it was accepted against. The
// history is the point, so this is the assertion that says so.
assert.equal((await store.readRevision(accepted.authority.currentRevision)).id, accepted.authority.currentRevision)
const stale = await store.submit({ ...snapshot('incoming\n'), expectedRevision: first.authority.currentRevision })
assert.equal(stale.status, 'stale-base')
assert.equal((await store.readAuthority()).currentRevision, accepted.authority.currentRevision)
assert.equal((await store.readRevisionFile(stale.evidence.incomingRevision, 'main.tex')).toString(), 'incoming\n')
assert.equal(stale.evidence.currentRevision, accepted.authority.currentRevision)
assert.equal(stale.evidence.classifications[0].status, 'conflict')

const cleanRoot = mkdtempSync(join(tmpdir(), 'tlda-source-clean-rebase-'))
const cleanStore = createSourceLifecycleStore({ root: cleanRoot, context: { format: 'svg', mainFile: 'main.tex' } })
const cleanBase = await cleanStore.bootstrap({
  expectedRevision: null,
  sourceManifest: ['main.tex', 'notes.tex'],
  files: [
    { path: 'main.tex', content: 'base main\n' },
    { path: 'notes.tex', content: 'base notes\n' },
  ],
})
const cleanCurrent = await cleanStore.submit({
  expectedRevision: cleanBase.authority.currentRevision,
  sourceManifest: ['main.tex', 'notes.tex'],
  files: [
    { path: 'main.tex', content: 'alice main\n' },
    { path: 'notes.tex', content: 'base notes\n' },
  ],
})
const cleanStale = await cleanStore.submit({
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
assert.equal((await cleanStore.readAuthority()).currentRevision, cleanStale.authority.currentRevision)
assert.deepEqual(
  await Promise.all((await cleanStore.readRevision(cleanStale.authority.currentRevision)).manifest.map(
    async path => [path, (await cleanStore.readRevisionFile(cleanStale.authority.currentRevision, path)).toString()],
  )),
  [['main.tex', 'alice main\n'], ['notes.tex', 'bob notes\n']],
)

const pinRoot = mkdtempSync(join(tmpdir(), 'tlda-source-pins-'))
const pins = createSourceLifecycleStore({ root: pinRoot, context: { format: 'svg', mainFile: 'main.tex' } })
const pinA = await pins.bootstrap({ ...snapshot('same\n'), dependencyPins: [{ version: '1', name: 'dep' }] })
const pinB = await pins.submit({ ...snapshot('same\n'), expectedRevision: pinA.authority.currentRevision, dependencyPins: [{ name: 'dep', version: '2' }] })
assert.notEqual(pinA.authority.currentRevision, pinB.authority.currentRevision)
// Pins survive the round trip through the commit. They ride in a commit trailer
// rather than in the tree, because the tree is what lands on the author's disk
// and a pin is not a file of theirs.
assert.deepEqual((await pins.readRevision(pinB.authority.currentRevision)).dependencyPins, [{ name: 'dep', version: '2' }])
assert.deepEqual((await pins.readRevision(pinA.authority.currentRevision)).dependencyPins, [{ name: 'dep', version: '1' }])

// Identical content in two independent stores is the same TREE and two different
// ids. Under the previous store the ids matched, because an id was a hash of the
// content; under commits they cannot, and nothing should ask them to. Anything
// wanting "do these say the same thing" compares manifests, which is what
// bootstrap's reconciliation check does.
const idRootA = mkdtempSync(join(tmpdir(), 'tlda-source-id-a-'))
const idRootB = mkdtempSync(join(tmpdir(), 'tlda-source-id-b-'))
const twoFiles = content => ({
  expectedRevision: null,
  sourceManifest: ['main.tex', 'notes.tex'],
  files: [{ path: 'main.tex', content: 'shared\n' }, { path: 'notes.tex', content }],
})
const storeA = createSourceLifecycleStore({ root: idRootA, context: { format: 'svg', mainFile: 'main.tex' } })
const storeB = createSourceLifecycleStore({ root: idRootB, context: { format: 'svg', mainFile: 'main.tex' } })
const idA = await storeA.bootstrap(twoFiles('same\n'))
const idB = await storeB.bootstrap(twoFiles('same\n'))
const blobsOf = revision => revision.files.map(file => [file.path, file.sha256])
assert.deepEqual(
  blobsOf(await storeA.readRevision(idA.authority.currentRevision)),
  blobsOf(await storeB.readRevision(idB.authority.currentRevision)),
)
const idRootC = mkdtempSync(join(tmpdir(), 'tlda-source-id-c-'))
const storeC = createSourceLifecycleStore({ root: idRootC, context: { format: 'svg', mainFile: 'main.tex' } })
const idC = await storeC.bootstrap(twoFiles('different\n'))
assert.notDeepEqual(
  blobsOf(await storeA.readRevision(idA.authority.currentRevision)),
  blobsOf(await storeC.readRevision(idC.authority.currentRevision)),
)

// A revision accepted before the cutover stays readable at the id it already
// has, and a push on top of it carries its content into git. This is what lets a
// live project cross without a migration pass, and it is the case that can lose
// somebody's history if it breaks.
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
assert.equal((await legacy.readCurrentFile('main.tex')).content.toString(), 'base\n')
assert.equal((await legacy.readRevisionFile(legacyId, 'main.tex')).toString(), 'base\n')
assert.equal((await legacy.readAuthority()).currentRevision, legacyId)
const afterLegacy = await legacy.submit({
  expectedRevision: legacyId,
  sourceManifest: ['added.tex', 'main.tex'],
  files: [
    { path: 'added.tex', content: Buffer.from('added\n').toString('base64'), encoding: 'base64' },
    (await legacy.readRevision(legacyId)).files[0],
  ],
})
assert.equal(afterLegacy.ok, true)
assert.match(afterLegacy.authority.currentRevision, /^[0-9a-f]{40}$/)
assert.equal((await legacy.readRevisionFile(afterLegacy.authority.currentRevision, 'main.tex')).toString(), 'base\n')
assert.equal((await legacy.readRevisionFile(afterLegacy.authority.currentRevision, 'added.tex')).toString(), 'added\n')
// The legacy revision is still readable AFTER the cutover push, not only before.
assert.equal((await legacy.readRevisionFile(legacyId, 'main.tex')).toString(), 'base\n')

// A push whose base is a legacy revision must not see every file as changed. The
// two stores hash differently -- sha256 of raw bytes against git's blob sha --
// so comparing them in their own spaces would classify an untouched file as
// moved by both sides, and turn a clean push into a wall of conflicts on the one
// push that crosses the cutover.
const crossRoot = mkdtempSync(join(tmpdir(), 'tlda-source-cross-'))
const crossId = 'sha256:1111111111111111111111111111111111111111111111111111111111111111'
mkdirSync(join(crossRoot, 'revisions', encodeURIComponent(crossId)), { recursive: true })
writeFileSync(join(crossRoot, 'revisions', encodeURIComponent(crossId), 'snapshot.json'), JSON.stringify({
  version: 1, id: crossId, manifest: ['main.tex', 'untouched.tex'],
  files: [
    { path: 'main.tex', content: Buffer.from('base main\n').toString('base64') },
    { path: 'untouched.tex', content: Buffer.from('figure\n').toString('base64') },
  ],
  byteSize: 17, dependencyPins: [], createdAt: '2026-07-22T12:15:15.000Z',
}))
writeFileSync(join(crossRoot, 'authority.json'), JSON.stringify({ state: 'current', currentRevision: crossId }))
const cross = createSourceLifecycleStore({ root: crossRoot, context: { format: 'svg', mainFile: 'main.tex' } })
const crossFiles = main => ({
  sourceManifest: ['main.tex', 'untouched.tex'],
  files: [{ path: 'main.tex', content: main }, { path: 'untouched.tex', content: 'figure\n' }],
})
const crossCurrent = await cross.submit({ ...crossFiles('alice main\n'), expectedRevision: crossId })
assert.equal(crossCurrent.ok, true)
const crossStale = await cross.submit({ ...crossFiles('bob main\n'), expectedRevision: crossId })
assert.equal(crossStale.status, 'stale-base')
const untouched = crossStale.evidence.classifications.find(item => item.path === 'untouched.tex')
assert.equal(untouched.status, 'clean-rebase-candidate')

const clean = classifyThreeWay({ base: 'a\nkeep-1\nkeep-2\nb\n', current: 'A\nkeep-1\nkeep-2\nb\n', incoming: 'a\nkeep-1\nkeep-2\nB\n' })
assert.equal(clean.status, 'clean-rebase-candidate')
const conflict = classifyThreeWay({ base: 'a\n', current: 'ours\n', incoming: 'theirs\n' })
assert.equal(conflict.status, 'conflict')
assert.match(conflict.merged, /<<<<<<<|>>>>>>>/)
assert.equal(classifyThreeWay({ base: null, current: 'a', incoming: 'b' }).status, 'classification-unavailable')
assert.equal(classifyThreeWay({ base: 'a', current: 'b', incoming: 'c', binary: true }).status, 'classification-unavailable')

const reconcileRoot = mkdtempSync(join(tmpdir(), 'tlda-source-reconcile-'))
const reconcile = createSourceLifecycleStore({ root: reconcileRoot, context: { format: 'svg', mainFile: 'main.tex' } })
const held = await reconcile.bootstrap({ ...snapshot('proposed\n'), observedServerFiles: [{ path: 'main.tex', content: 'existing\n' }] })
assert.equal(held.status, 'reconciliation-required')
assert.equal((await reconcile.readAuthority()).currentRevision, null)
assert.equal((await reconcile.readRevisionFile(held.authority.evidenceRevision, 'main.tex')).toString(), 'existing\n')

// Bootstrap where both sides AGREE must not be held. Two commits of identical
// content have different shas, so comparing revision ids here would report every
// bootstrap as a disagreement and no project could ever be adopted.
const agreeRoot = mkdtempSync(join(tmpdir(), 'tlda-source-agree-'))
const agree = createSourceLifecycleStore({ root: agreeRoot, context: { format: 'svg', mainFile: 'main.tex' } })
const agreed = await agree.bootstrap({ ...snapshot('same\n'), observedServerFiles: [{ path: 'main.tex', content: 'same\n' }] })
assert.equal(agreed.ok, true)
assert.equal(agreed.status, 'accepted')

const partialRoot = mkdtempSync(join(tmpdir(), 'tlda-source-partial-'))
const partial = createSourceLifecycleStore({ root: partialRoot, context: { format: 'svg', mainFile: 'main.tex' } })
const partialHeld = await partial.bootstrap({
  expectedRevision: null,
  sourceManifest: ['main.tex', 'notes.tex'],
  files: [{ path: 'main.tex', content: 'proposed\n' }, { path: 'notes.tex', content: 'notes\n' }],
  observedSourceManifest: ['main.tex'],
  observedServerFiles: [{ path: 'main.tex', content: 'proposed\n' }],
})
assert.equal(partialHeld.status, 'reconciliation-required')
assert.deepEqual((await partial.readRevision(partialHeld.authority.evidenceRevision)).manifest, ['main.tex'])

const crashRoot = mkdtempSync(join(tmpdir(), 'tlda-source-crash-'))
const crashing = createSourceLifecycleStore({ root: crashRoot, context: { format: 'svg', mainFile: 'main.tex' }, fault(stage) { if (stage === 'before-rename') throw new Error('injected crash') } })
await assert.rejects(() => crashing.bootstrap(snapshot('never-current\n')), /injected crash/)
assert.deepEqual(await crashing.readAuthority(), { state: 'uninitialized', currentRevision: null, acceptSeq: 0 })

const authorityJson = readFileSync(join(root, 'authority.json'), 'utf8')
assert.doesNotMatch(authorityJson, /expires|retention|deleteAfter|quota/i)
console.log('source lifecycle authority tests passed')
