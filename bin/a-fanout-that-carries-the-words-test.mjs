#!/usr/bin/env node
//
// **The fan-out carries the words, not just the filenames.**
//
// Two consumers read the accepted-mutation payload and only one of them reads
// `blobs`. The daemon's materializer looks bytes up by blob id. The source
// ROOM reads `file.content` directly:
//
//   const incoming = file ? bufferFromBase64(file.content).toString('utf8') : ''
//
// Send `{path}` with no content and the room FINDS the entry, gets `undefined`,
// and merges an **empty string** against its own text. Somebody's accepted
// paragraph arrives as nothing.
//
// **And nothing surfaces it.** The merge succeeds — it merges emptiness — so
// `applyAcceptedSourceMutation` returns `{ok: true, applied: [...]}`, the
// fan-out reports applied, the accept reports accepted, and the room quietly
// holds the wrong text. Both ends contain `files`, so every grep is healthy.
// That is the reconstruction hazard with the payload itself as the field that
// went missing, and it is live data loss in the collaboration path.
//
// So this asserts the BYTES in the dispatched payload rather than the shape of
// it, because the shape was never wrong.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  acceptSourceSnapshot, setAcceptedSourceMutationHandler, setSourceBindingTargetProvider,
} from '../server/routes/projects.mjs'
import { closeProjectStore, createProject, initProjectStore } from '../server/lib/project-store.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-words-'))
await initProjectStore(path.join(root, 'projects'))
const project = 'paper'
await createProject({ name: project, format: 'svg', mainFile: 'main.tex' })

setSourceBindingTargetProvider(async () => ([
  { bindingId: 'a-binding', daemonKey: 'a-machine', sourceDir: '/somewhere/checkout' },
]))
const told = []
setAcceptedSourceMutationHandler(async message => { told.push(message) })

const first = await acceptSourceSnapshot(project, {
  expectedRevision: null,
  sourceManifest: ['main.tex', 'notes.tex'],
  files: [
    { path: 'main.tex', content: 'the paper\n' },
    { path: 'notes.tex', content: 'some notes\n' },
  ],
})
assert.equal(first.status, 200, JSON.stringify(first.body).slice(0, 200))

// An edit to one file, with the other carried forward by reference — the shape
// every incremental push has.
const paragraph = 'a paragraph somebody else is waiting to read\n'
const second = await acceptSourceSnapshot(project, {
  expectedRevision: first.body.sourceRevision,
  sourceManifest: ['main.tex', 'notes.tex'],
  files: [{ path: 'main.tex', content: paragraph }],
})
assert.equal(second.status, 200, JSON.stringify(second.body).slice(0, 200))

for (let i = 0; i < 50 && told.length < 2; i += 1) await new Promise(r => setTimeout(r, 20))
assert.ok(told.length >= 2, `the fan-out dispatched (saw ${told.length})`)

const message = told[told.length - 1]
const entry = (message.files || []).find(file => file?.path === 'main.tex')
assert.ok(entry, 'the changed file is named in the fan-out')

// **THE WORDS.** This is the assertion the defect walks straight past: the
// entry existed, so a shape check passes and the room still gets nothing.
assert.notEqual(entry.content, undefined,
  'THE WORDS: the fan-out entry carries content, not just a path')
assert.equal(
  Buffer.from(entry.content, 'base64').toString('utf8'), paragraph,
  'and the content is what was accepted, decodable the way the room decodes it',
)

// The room's own read, reproduced exactly, since that is the consumer that
// silently merged emptiness.
const asTheRoomReadsIt = entry ? Buffer.from(String(entry.content || ''), 'base64').toString('utf8') : ''
assert.equal(asTheRoomReadsIt, paragraph,
  'AS THE ROOM READS IT: the text a collaborator receives is the text that was accepted')
assert.notEqual(asTheRoomReadsIt, '',
  'and specifically not the empty string, which is what merging a missing content produces')

setAcceptedSourceMutationHandler(null)
setSourceBindingTargetProvider(null)
await closeProjectStore()
fs.rmSync(root, { recursive: true, force: true })
console.log('a fanout that carries the words: a collaborator receives the paragraph, not an empty string')
process.exit(0)
