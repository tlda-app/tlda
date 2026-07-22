#!/usr/bin/env node
import assert from 'assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createProject, initProjectStore, readSourceFile, sourceLifecycleStore } from '../server/lib/project-store.mjs'
import { processProjectPush } from '../server/routes/projects.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-source-http-'))
initProjectStore(root)
createProject({ name: 'authority-http', title: 'Authority HTTP' })

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
assert.match(first.sourceRevision, /^sha256:/)
assert.equal(readSourceFile('authority-http', 'main.tex'), 'base\n')

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
})
assert.equal(stale.status, 409)
assert.equal(stale.lifecycleStatus, 'stale-base')
assert.equal(readSourceFile('authority-http', 'main.tex'), 'current\n')
assert.equal(sourceLifecycleStore('authority-http').readAuthority().currentRevision, deleted.sourceRevision)
const evidenceRoot = join(root, 'authority-http', '.source-lifecycle', 'evidence')
assert.ok(existsSync(evidenceRoot) && readdirSync(evidenceRoot).length === 1, 'stale evidence must survive transaction rollback')

const failed = await processProjectPush('authority-http', {
  expectedRevision: deleted.sourceRevision,
  sourceManifest: ['main.tex'],
  files: [{ path: 'main.tex', content: 'must roll back\n' }],
}, { failAt: 'manifest' })
assert.equal(failed.status, 409)
assert.equal(readSourceFile('authority-http', 'main.tex'), 'current\n')
assert.equal(sourceLifecycleStore('authority-http').readAuthority().currentRevision, deleted.sourceRevision)
const revisionsRoot = join(root, 'authority-http', '.source-lifecycle', 'revisions')
assert.ok(readdirSync(revisionsRoot).length >= 4, 'immutable incoming revision must survive authority rollback')

const authority = JSON.parse(readFileSync(join(root, 'authority-http', '.source-lifecycle', 'authority.json'), 'utf8'))
assert.equal(authority.currentRevision, deleted.sourceRevision)
console.log('source lifecycle HTTP/rollback tests passed')
