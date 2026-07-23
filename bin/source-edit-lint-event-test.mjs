#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  GRAMMAR_REPAIR_CHOICES,
  lintSourceEditFiles,
  ordinaryChatNudgeText,
  sourceEditNudgeText,
} from '../bots/grammar-source-edit.mjs'
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

const lintCalls = []
const findings = await lintSourceEditFiles(files, async (content, file) => {
  lintCalls.push({ content, file })
  return [{ file, line: 1, snippet: 'x=5, y=6' }]
})
assert.deepEqual(lintCalls, [{ content: 'We have $x=5, y=6$.', file: 'main.tex' }])
assert.deepEqual(findings, [{ file: 'main.tex', line: 3, snippet: 'x=5, y=6' }])
assert.equal(
  sourceEditNudgeText('lint-probe', findings),
  '⚠ **Possible comma splice** at `lint-probe/main.tex:3`: `x=5, y=6`. Replace the comma with the connective you mean — for example “where”, “and”, “so”, or “we have”.',
)
assert.deepEqual(GRAMMAR_REPAIR_CHOICES, ['where', 'and', 'so', 'we have'])
const ordinaryPrompt = ordinaryChatNudgeText([{ file: '<chat>', line: 1, snippet: 'x=5, y=6' }])
const sourcePrompt = sourceEditNudgeText('lint-probe', findings)
assert.match(ordinaryPrompt, /"where", "and", "so", "we have"/)
assert.match(sourcePrompt, /“where”, “and”, “so”, or “we have”/)
assert.doesNotMatch(ordinaryPrompt, /which gives/)
assert.doesNotMatch(sourcePrompt, /which gives/)

const projectsSource = readFileSync(new URL('../server/routes/projects.mjs', import.meta.url), 'utf8')
const unifiedSource = readFileSync(new URL('../server/unified-server.mjs', import.meta.url), 'utf8')
assert.match(projectsSource, /export async function processProjectPush[\s\S]*emitSourceEditEvent\(/)
assert.match(unifiedSource, /processProjectPush\(project, \{ files, deletedFiles, sourceManifest, editedBy, expectedRevision, requestId \}\)/)
assert.doesNotMatch(unifiedSource, /createSourceEditEvent/)

console.log('source-edit lint event tests passed')
