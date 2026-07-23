#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createSourceEditEvent } from '../server/lib/source-edit-event.mjs'

const files = [{ path: 'main.tex', content: 'We have $x=5, y=6$.' }]
const input = {
  project: 'lint-probe',
  files,
  editedBy: 'fleet:author',
  requestId: 'request-1',
}

assert.equal(createSourceEditEvent({ ...input, result: { ok: false } }), null)
assert.equal(createSourceEditEvent({ ...input, result: { ok: true }, editedBy: null }), null)
assert.deepEqual(createSourceEditEvent({ ...input, result: { ok: true } }), {
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

console.log('source-edit lint event tests passed')
