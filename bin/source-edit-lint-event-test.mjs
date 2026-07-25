#!/usr/bin/env node
// The grammar bot's half of this test moved out with the bot to
// ~/work/tlda-bots/grammar/source-edit-lint-test.mjs. This file keeps the
// app-side half: the source-edit event machinery and changed-region diffing.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { changedTextRegions } from '../server/lib/changed-text-regions.mjs'
import { createSourceEditEvent, emitSourceEditEvent } from '../server/lib/source-edit-event.mjs'

const files = [{
  path: 'main.tex',
  regions: [{ startLine: 3, content: 'We have $x=5, y=6$.' }],
}]
const input = {
  project: 'lint-probe',
  editedBy: 'fleet:author',
  requestId: 'request-1',
}

assert.equal(createSourceEditEvent({ ...input, result: { ok: false } }), null)
assert.equal(createSourceEditEvent({ ...input, result: { ok: true }, editedBy: null }), null)
assert.equal(createSourceEditEvent({ ...input, result: { ok: true, unchanged: true, acceptedChangedFiles: files } }), null)
assert.equal(createSourceEditEvent({ ...input, result: { ok: true, filtered: true, acceptedChangedFiles: files } }), null)
assert.equal(createSourceEditEvent({ ...input, result: { ok: true, acceptedChangedFiles: [] } }), null)
assert.deepEqual(createSourceEditEvent({ ...input, result: {
  ok: true,
  acceptedChangedFiles: [
    files[0],
    { path: 'notes.md', regions: [{ startLine: 1, content: 'ignored' }] },
    { path: 'unchanged.tex', regions: [] },
  ],
} }), {
  type: 'source-edit',
  from: 'fleet:tlda',
  to: 'fleet:author',
  text: 'Source edit — lint-probe',
  metadata: {
    project: 'lint-probe',
    files,
    requestId: 'request-1',
  },
})

const emitted = []
assert.ok(emitSourceEditEvent({
  emit: (type, event) => emitted.push({ type, event }),
  ...input,
  result: { ok: true, acceptedChangedFiles: files },
}))
assert.equal(emitted.length, 1)
assert.equal(emitted[0].type, 'source-edit')
assert.equal(emitSourceEditEvent({
  emit: () => emitted.push('unexpected'),
  ...input,
  result: { ok: true, unchanged: true, acceptedChangedFiles: files },
}), null)
assert.equal(emitted.length, 1)

assert.deepEqual(
  changedTextRegions(
    ['old issue $a=1, b=2$.', 'keep', 'old middle', 'keep again', 'tail'].join('\n'),
    ['old issue $a=1, b=2$.', 'new clean line', 'old middle', 'new issue $x=5, y=6$.', 'tail'].join('\n'),
  ),
  [
    { startLine: 2, content: 'new clean line' },
    { startLine: 4, content: 'new issue $x=5, y=6$.' },
  ],
)
assert.deepEqual(changedTextRegions('same', 'same'), [])

const projectsSource = readFileSync(new URL('../server/routes/projects.mjs', import.meta.url), 'utf8')
const unifiedSource = readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
assert.match(projectsSource, /export async function processProjectPush[\s\S]*emitSourceEditEvent\(/)
assert.match(unifiedSource, /processProjectPush\(project, \{ files, deletedFiles, sourceManifest, editedBy, expectedRevision, requestId \}\)/)
assert.doesNotMatch(unifiedSource, /createSourceEditEvent/)

console.log('source-edit lint event tests passed')
