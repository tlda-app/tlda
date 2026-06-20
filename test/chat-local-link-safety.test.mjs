import test from 'node:test'
import assert from 'node:assert/strict'

import {
  rewriteBareLocalPaths,
  rewriteLocalFileAnchors,
} from '../shared/chat-local-link-safety.mjs'

test('tilde markdown link output is converted to a file chip instead of a clickable tilde URL', () => {
  const before = '<a target="_blank" href="~/work/tlda/scratch/app-report.md">shared report</a>'
  const after = rewriteLocalFileAnchors(before)

  assert.doesNotMatch(after, /<a\b/i)
  assert.match(after, /class="md-file-card scratch-card"/)
  assert.match(after, /data-path="~\/work\/tlda\/scratch\/app-report\.md"/)
  assert.match(after, />shared report</)
})

test('local api file link output is converted to a file chip instead of a nested local URL link', () => {
  const before = '<a target="_blank" href="/api/file?path=%2FUsers%2Fskip%2Fwork%2Ftlda%2Fscratch%2Fapp-report.md">~/work/tlda/scratch/app-report.md</a>'
  const after = rewriteLocalFileAnchors(before)

  assert.doesNotMatch(after, /<a\b/i)
  assert.match(after, /class="md-file-card scratch-card"/)
  assert.match(after, /data-path="\/Users\/skip\/work\/tlda\/scratch\/app-report\.md"/)
  assert.match(after, /<span class="md-file-chip">~\/work\/tlda\/scratch\/app-report\.md<\/span>/)
})

test('bare local path rewriter skips existing anchor contents to avoid nested links or chips', () => {
  const before = '<a target="_blank" href="https://example.test/report">/Users/skip/work/tlda/scratch/app-report.md</a>'
  const after = rewriteBareLocalPaths(before)

  assert.equal(after, before)
  assert.doesNotMatch(after, /md-file-card/)
})
