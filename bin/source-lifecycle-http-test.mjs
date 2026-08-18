#!/usr/bin/env node
import assert from 'assert/strict'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { closeProjectStore, createProject, initProjectStore, readProject, readSourceFile, sourceLifecycleStore, updateClientSourceManifest, writeSourceFile } from '../server/lib/project-store.mjs'
import { processProjectPush } from '../server/routes/projects.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-source-http-'))
await initProjectStore(root)
createProject({ name: 'authority-http', title: 'Authority HTTP' })

createProject({ name: 'authority-bootstrap', title: 'Authority Bootstrap' })
writeSourceFile('authority-bootstrap', 'legacy-preserved.tex', 'surviving server bytes\n')
await updateClientSourceManifest('authority-bootstrap', ['legacy-preserved.tex'])
const watchedFiles = Array.from({ length: 10 }, (_, index) => ({
  path: `watched-${index + 1}.tex`,
  content: `filesystem bytes ${index + 1}\n`,
}))
const bootstrapped = await processProjectPush('authority-bootstrap', {
  expectedRevision: null,
  sourceManifest: ['legacy-preserved.tex', ...watchedFiles.map(file => file.path)],
  files: watchedFiles,
})
assert.equal(bootstrapped.status, 200, bootstrapped.error)
assert.equal(readSourceFile('authority-bootstrap', 'legacy-preserved.tex'), 'surviving server bytes\n')
for (const file of watchedFiles) assert.equal(readSourceFile('authority-bootstrap', file.path), file.content)

createProject({ name: 'authority-bootstrap-collision', title: 'Authority Bootstrap Collision' })
writeSourceFile('authority-bootstrap-collision', 'legacy-preserved.tex', 'surviving server bytes\n')
writeSourceFile('authority-bootstrap-collision', 'unowned-collision.tex', 'unowned server bytes\n')
await updateClientSourceManifest('authority-bootstrap-collision', ['legacy-preserved.tex'])
const collision = await processProjectPush('authority-bootstrap-collision', {
  expectedRevision: null,
  sourceManifest: ['legacy-preserved.tex', 'unowned-collision.tex'],
  files: [{ path: 'unowned-collision.tex', content: 'incoming bytes\n' }],
})
assert.equal(collision.status, 409)
assert.equal(collision.lifecycleStatus, 'reconciliation-required')
assert.equal(readSourceFile('authority-bootstrap-collision', 'unowned-collision.tex'), 'unowned server bytes\n')

const missing = await processProjectPush('authority-http', {
  sourceManifest: ['main.tex'],
  files: [{ path: 'main.tex', content: 'must not write\n' }],
})
assert.equal(missing.status, 428)
assert.equal(readSourceFile('authority-http', 'main.tex'), null)

const first = await processProjectPush('authority-http', {
  expectedRevision: null,
  sourceManifest: ['main.tex'],
  files: [{ path: 'main.tex', content: 'base\n' }],
})
assert.equal(first.status, 200)
// The revision id is now a git commit sha (content-addressed store), not the
// old `sha256:<hex>` label.
assert.match(first.sourceRevision, /^[0-9a-f]{40}$/)
assert.equal(readSourceFile('authority-http', 'main.tex'), 'base\n')
assert.deepEqual(await (await sourceLifecycleStore('authority-http')).readCurrentFile('main.tex'), {
  sourceRevision: first.sourceRevision,
  content: Buffer.from('base\n'),
})

const second = await processProjectPush('authority-http', {
  expectedRevision: first.sourceRevision,
  sourceManifest: ['main.tex'],
  files: [{ path: 'main.tex', content: 'current\n' }],
})
assert.equal(second.status, 200)

const added = await processProjectPush('authority-http', {
  expectedRevision: second.sourceRevision,
  sourceManifest: ['main.tex', 'notes.tex'],
  files: [{ path: 'notes.tex', content: 'notes\n' }],
})
assert.equal(added.status, 200)
assert.equal(readSourceFile('authority-http', 'notes.tex'), 'notes\n')
const addedRevision = await (await sourceLifecycleStore('authority-http')).readRevision(added.sourceRevision)
assert.equal(addedRevision.byteSize, Buffer.byteLength('current\n') + Buffer.byteLength('notes\n'), 'unchanged snapshot bytes must not be base64-encoded again')

const renamed = await processProjectPush('authority-http', {
  expectedRevision: added.sourceRevision,
  sourceManifest: ['main.tex', 'renamed.tex'],
  files: [{ path: 'renamed.tex', content: 'notes\n' }],
  deletedFiles: ['notes.tex'],
})
assert.equal(renamed.status, 200)
assert.equal(readSourceFile('authority-http', 'notes.tex'), null)
assert.equal(readSourceFile('authority-http', 'renamed.tex'), 'notes\n')

const deleted = await processProjectPush('authority-http', {
  expectedRevision: renamed.sourceRevision,
  sourceManifest: ['main.tex'],
  files: [],
  deletedFiles: ['renamed.tex'],
})
assert.equal(deleted.status, 200)
assert.equal(readSourceFile('authority-http', 'renamed.tex'), null)

const stale = await processProjectPush('authority-http', {
  expectedRevision: first.sourceRevision,
  sourceManifest: ['main.tex'],
  files: [{ path: 'main.tex', content: 'stale incoming\n' }],
  editedBy: 'bob',
  sourceDaemonKey: 'mini:testing:bob',
})
assert.equal(stale.status, 409)
assert.equal(stale.lifecycleStatus, 'stale-base')
assert.equal(readSourceFile('authority-http', 'main.tex'), 'current\n')
assert.equal((await (await sourceLifecycleStore('authority-http')).readAuthority()).currentRevision, deleted.sourceRevision)
let conflictState = (await readProject('authority-http')).sourceSyncConflicts
assert.equal(conflictState.length, 1)
assert.equal(conflictState[0].file, 'main.tex')
assert.equal(conflictState[0].owner.daemonKey, 'mini:testing:bob')
assert.equal(conflictState[0].source, 'source-authority')
// Dropped: "stale evidence must survive transaction rollback" asserted the old
// snapshot-copy store's evidence-directory internals. The new git-object store
// has no separate evidence-copy phase to survive rollback of; the promise this
// protected — the conflict is recorded and recoverable — is covered above by
// the `sourceSyncConflicts` assertions instead.

const resolved = await processProjectPush('authority-http', {
  expectedRevision: deleted.sourceRevision,
  sourceManifest: ['main.tex'],
  files: [{ path: 'main.tex', content: 'resolved\n' }],
  editedBy: 'bob',
  sourceDaemonKey: 'mini:testing:bob',
})
assert.equal(resolved.status, 200)
conflictState = (await readProject('authority-http')).sourceSyncConflicts
assert.deepEqual(conflictState, [], 'cleanly accepted file clears its owned source conflict')

const failed = await processProjectPush('authority-http', {
  expectedRevision: resolved.sourceRevision,
  sourceManifest: ['main.tex'],
  files: [{ path: 'main.tex', content: 'must roll back\n' }],
}, { failAt: 'manifest' })
assert.equal(failed.status, 409)
assert.equal(readSourceFile('authority-http', 'main.tex'), 'resolved\n')
// KNOWN RED, not a defect in this test: a rejected push (failAt: 'manifest')
// still moves the git ref, so `currentRevision` reads the failed attempt's sha
// instead of staying on the pre-attempt revision. This is the same
// "rejected write leaves nothing behind" violation independently found in
// `bin/source-manifest-contract-test.mjs`'s `manifest`-failAt case tonight —
// reported to pm-sync as a pre-existing production defect in the new
// git-ref layer, not something to fix here. Left asserting the real promise.
assert.equal((await (await sourceLifecycleStore('authority-http')).readAuthority()).currentRevision, resolved.sourceRevision)
// Dropped: "immutable incoming revision must survive authority rollback" counted
// entries in the old snapshot-copy store's revisions directory. The new
// git-object store's immutability comes from content-addressing itself, not a
// revisions-directory count; a rejected push's git ref not moving is asserted
// above (authority.currentRevision unchanged) and is the load-bearing half of
// this promise on the new mechanism.

const authority = JSON.parse(readFileSync(join(root, 'authority-http', '.source-lifecycle', 'authority.json'), 'utf8'))
assert.equal(authority.currentRevision, resolved.sourceRevision)
console.log('source lifecycle HTTP/rollback tests passed')
await closeProjectStore()
