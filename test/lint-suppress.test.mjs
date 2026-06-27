// Tests for the suppression-pattern linter — focused on the empty-or-log-only
// catch detection, its reason-comment escape, the blocking-pattern set, and the
// non-source path exclusion.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lintText, lintDiff, BLOCKING_PATTERNS } from '../server/lib/lint-suppress.mjs'

const catchHits = (code) =>
  lintText(code, 'sample.mjs').filter((f) => f.pattern === 'empty-or-log-only-catch')

test('flags empty and log-only catches (including console.error / log.* / logger.*)', () => {
  const flagged = [
    'try{x()}catch{}',
    'try{x()}catch(e){}',
    'try{x()}catch{ /* ignore */ }',
    'try{x()}catch(e){ console.log(e) }',
    'try{x()}catch(e){ console.error("boom", e) }',
    'try{x()}catch(e){ log.error("ns","boom",{e}) }',
    'try{x()}catch(e){ log.warn("x") }',
    'try{x()}catch(e){ logger.error(e) }',
  ]
  for (const code of flagged) assert.equal(catchHits(code).length, 1, `should flag: ${code}`)
})

test('exempts a catch with a real reason comment, and any catch that recovers/rethrows', () => {
  const allowed = [
    'try{x()}catch{ /* best-effort: pid may already be dead */ }',
    'try{x()}catch(e){ /* daemon offline is expected here */ log.warn(e) }',
    'try{x()}catch(e){ log.error(e); throw e }',
    'try{x()}catch(e){ log.error(e); return fallback() }',
    'try{x()}catch(e){ doCleanup(e) }',
  ]
  for (const code of allowed) assert.equal(catchHits(code).length, 0, `should allow: ${code}`)
})

test('filler comments ("ignore"/"noop") do NOT count as a reason', () => {
  assert.equal(catchHits('try{x()}catch{ /* ignore */ }').length, 1)
  assert.equal(catchHits('try{x()}catch{ /* noop, skip */ }').length, 1)
})

test('the catch pattern is the only blocking one (has a humane escape)', () => {
  assert.ok(BLOCKING_PATTERNS.has('empty-or-log-only-catch'))
  assert.ok(!BLOCKING_PATTERNS.has('python-bare-except-pass'))
  assert.ok(!BLOCKING_PATTERNS.has('as-any'))
})

test('lintDiff flags added source lines but skips fleet-data / dist artifacts', () => {
  const mk = (file) => `+++ b/${file}\n@@ -1 +1,1 @@\n+try{a()}catch(e){console.error(e)}\n`
  const read = () => 'try{a()}catch(e){console.error(e)}'
  assert.equal(lintDiff(mk('bin/foo.mjs'), read).length, 1)
  assert.equal(lintDiff(mk('mcp-server/fleet-data/uploads/x-123.mjs'), read).length, 0)
  assert.equal(lintDiff(mk('dist/bundle.mjs'), read).length, 0)
})

test('lintDiff only flags newly-added lines, not pre-existing ones', () => {
  // The catch is on line 3, but the diff only adds line 2 → no finding.
  const diff = '+++ b/bin/foo.mjs\n@@ -1,0 +2,1 @@\n+const y = 1\n'
  const content = 'const x = 1\nconst y = 1\ntry{a()}catch{}\n'
  assert.equal(lintDiff(diff, () => content).length, 0)
})
