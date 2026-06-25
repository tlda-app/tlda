import test from 'node:test'
import assert from 'node:assert/strict'

import {
  rewriteBareLocalPaths,
} from '../shared/chat-local-link-safety.mjs'

test('tilde markdown link output stays a link, not a file chip', () => {
  const before = '<a target="_blank" href="~/work/tlda/scratch/app-report.md">shared report</a>'
  const after = rewriteBareLocalPaths(before)

  assert.equal(after, before)
  assert.doesNotMatch(after, /md-file-card|ref-chip/)
})

test('local api file link output stays a link, not a file chip', () => {
  const before = '<a target="_blank" href="/api/file?path=%2FUsers%2Fskip%2Fwork%2Ftlda%2Fscratch%2Fapp-report.md">~/work/tlda/scratch/app-report.md</a>'
  const after = rewriteBareLocalPaths(before)

  assert.equal(after, before)
  assert.doesNotMatch(after, /md-file-card|ref-chip/)
})

test('bare local path rewriter skips existing anchor contents to avoid nested links or chips', () => {
  const before = '<a target="_blank" href="https://example.test/report">/Users/skip/work/tlda/scratch/app-report.md</a>'
  const after = rewriteBareLocalPaths(before)

  assert.equal(after, before)
  assert.doesNotMatch(after, /md-file-card/)
})
