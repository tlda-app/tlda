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
const markdownFile = {
  path: 'notes.md',
  regions: [{ startLine: 5, content: 'We have $a=1, b=2$.' }],
}
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
    markdownFile,
    { path: 'notes.txt', regions: [{ startLine: 1, content: 'ignored' }] },
    { path: 'unchanged.tex', regions: [] },
  ],
} }), {
  type: 'source-edit',
  from: 'fleet:tlda',
  to: 'fleet:author',
  text: 'Source edit — lint-probe',
  metadata: {
    project: 'lint-probe',
    files: [files[0], markdownFile],
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
// The accept no longer emits the edit event itself. `applyAcceptedSourceEffects`
// does, and the accept calls it -- so the promise takes two assertions where it
// used to take one, and each names the thing that actually owns it. Asserting
// only that the symbol appears somewhere in the file would pass even if the
// effects function had been orphaned.
assert.match(projectsSource, /export async function acceptSourceSnapshot[\s\S]*applyAcceptedSourceEffects\(/)
assert.match(projectsSource, /export async function applyAcceptedSourceEffects[\s\S]*emitSourceEditEvent\(/)
// The WS handler must keep carrying these fields. This is a source-text guard
// and it is the one that matters most here: the accept's own destructure names
// only what it uses itself, so a handler trimmed to that list would drop
// `editOperation`, `editOperations`, `deliveryId`, `sourceMachineId` and
// `sourceEnvName` silently while every grep for them still succeeded.
assert.match(unifiedSource, /acceptSourceSnapshot\(project, \{[\s\S]*files,[\s\S]*editedBy,[\s\S]*requestId,[\s\S]*sourceDaemonKey:/)
assert.match(unifiedSource, /event\?\.type === 'source-edit'[\s\S]*pushFilteredEvent\(event\)/)
assert.doesNotMatch(unifiedSource, /createSourceEditEvent/)

console.log('source-edit lint event tests passed')
