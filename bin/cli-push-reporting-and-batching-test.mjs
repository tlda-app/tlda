#!/usr/bin/env node

import assert from 'node:assert/strict'

const { requireAcceptedPush, sourceFileBatches } = await import(`../cli/tlda.mjs?push-reporting-test=${Date.now()}`)

assert.throws(
  () => requireAcceptedPush({ ok: false, error: 'rejected by test server' }),
  /rejected by test server/,
)
assert.equal(requireAcceptedPush({ ok: true, building: true }).building, true)
assert.equal(requireAcceptedPush({ building: true }).building, true)

assert.deepEqual(
  sourceFileBatches([
    { path: 'a.qmd', size: 9 },
    { path: 'b.qmd', size: 2 },
    { path: 'c.qmd', size: 8 },
  ], 10).map(batch => batch.map(file => file.path)),
  [['a.qmd'], ['b.qmd', 'c.qmd']],
)

console.log('PASS cli push reporting and batching')
