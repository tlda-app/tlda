#!/usr/bin/env node
import assert from 'node:assert/strict'
import { lintSourceEditFiles, sourceEditNudgeText } from '../bots/grammar-source-edit.mjs'
import { changedTextRegions } from '../server/lib/changed-text-regions.mjs'
import { createSourceEditEvent } from '../server/lib/source-edit-event.mjs'

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

console.log('source-edit lint event tests passed')
