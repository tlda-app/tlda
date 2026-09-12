// What an edit did, pinned.
//
// The card named the file and not the change, and his verdict was "ZERO EDITS
// ARE VISIBLE IN THE BRIDGE". So the case that matters most below is the one
// where prose he wrote came back reworded: that is the edit a person has to be
// able to stop on, and a filename and a line count cannot show it.
import test from 'node:test'
import assert from 'node:assert/strict'

import { summarizeChange, hunksFromPatch } from './edit-bridge-change.mjs'

const patch = (body) => `diff --git a/main.md b/main.md\n--- a/main.md\n+++ b/main.md\n${body}`

test('a rewrite reads as a replacement and shows both sides', () => {
  const change = summarizeChange(patch(
    '@@ -3,1 +3,1 @@\n' +
    '-The estimator is consistent under mild conditions.\n' +
    '+The estimator is consistent whenever the design is balanced.\n',
  ))
  assert.equal(change.kind, 'replacement')
  assert.match(change.excerpt.before, /mild conditions/)
  assert.match(change.excerpt.after, /design is balanced/)
  assert.ok(change.rewordedWords > 0, 'a replacement reports how much was reworded')
})

test('a pure addition is not a replacement', () => {
  // The distinction the agent-edit record turns on: "a large pure addition is
  // usually fine; replacing prose he already wrote is where the subtlety dies."
  const change = summarizeChange(patch('@@ -3,0 +4,2 @@\n+A new paragraph entirely.\n+And a second line of it.\n'))
  assert.equal(change.kind, 'addition')
  assert.equal(change.removedWords, 0)
  assert.equal(change.rewordedWords, 0, 'nothing of his was displaced')
})

test('a pure deletion says so rather than reading as a rewrite', () => {
  const change = summarizeChange(patch('@@ -3,2 +3,0 @@\n-A paragraph that went away.\n-And the rest of it.\n'))
  assert.equal(change.kind, 'deletion')
  assert.equal(change.addedWords, 0)
})

test('the excerpt is the biggest REWRITE, not the biggest hunk', () => {
  // A large addition elsewhere must not push the rewrite off the card: the
  // rewrite is the thing a person needs to see and the addition is not.
  const change = summarizeChange(patch(
    '@@ -3,1 +3,1 @@\n' +
    '-Lemma 6 holds for all bounded f.\n' +
    '+Lemma 6 holds for continuous f.\n' +
    '@@ -40,0 +41,4 @@\n' +
    '+One entirely new sentence here.\n' +
    '+Another entirely new sentence here.\n' +
    '+A third one, longer than the rewrite above by some margin.\n' +
    '+And a fourth for good measure, still nothing replaced.\n',
  ))
  assert.match(change.excerpt.before, /bounded f/, 'the rewrite wins the excerpt')
  assert.match(change.excerpt.after, /continuous f/)
})

test('LaTeX markup is stripped so the excerpt reads as prose', () => {
  const change = summarizeChange(patch(
    '@@ -3,1 +3,1 @@\n' +
    '-\\emph{The estimator} is \\textbf{consistent} here.\n' +
    '+\\emph{The estimator} is \\textbf{efficient} here.\n',
  ))
  assert.ok(!change.excerpt.before.includes('\\emph'), 'no command names in what a person reads')
  assert.match(change.excerpt.before, /The estimator is consistent here/)
  assert.match(change.excerpt.after, /efficient/)
})

test('markdown heading and emphasis markers do not reach the excerpt', () => {
  const change = summarizeChange(patch(
    '@@ -1,1 +1,1 @@\n' +
    '-## The **old** heading\n' +
    '+## The **new** heading\n',
  ))
  assert.equal(change.excerpt.before, 'The old heading')
  assert.equal(change.excerpt.after, 'The new heading')
})

test('a build with no textual change summarizes to nothing', () => {
  assert.equal(summarizeChange(''), null)
  assert.equal(summarizeChange('diff --git a/x b/x\n'), null)
})

test('a long rewrite is clipped rather than sent whole', () => {
  const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ')
  const change = summarizeChange(patch(`@@ -3,1 +3,1 @@\n-${long}\n+${long} tail\n`), { excerptChars: 60 })
  assert.ok(change.excerpt.before.length <= 61, 'the card stays compact -- spec 11')
  assert.ok(change.excerpt.before.endsWith('…'), 'and says it was clipped')
})

test('hunks are split per file so an excerpt names the right one', () => {
  const hunks = hunksFromPatch(
    'diff --git a/one.md b/one.md\n@@ -1,1 +1,1 @@\n-alpha\n+beta\n' +
    'diff --git a/two.md b/two.md\n@@ -1,1 +1,1 @@\n-gamma\n+delta\n',
  )
  assert.deepEqual(hunks.map(h => h.file), ['one.md', 'two.md'])
})

test('context lines end a hunk instead of joining the change', () => {
  // -U1 gives one line of context; it must not be read as changed prose.
  const change = summarizeChange(patch(
    '@@ -2,3 +2,3 @@\n' +
    ' unchanged context line\n' +
    '-was this\n' +
    '+is that\n' +
    ' more unchanged context\n',
  ))
  assert.ok(!change.excerpt.before.includes('unchanged'), 'context is not part of the change')
  assert.equal(change.excerpt.before, 'was this')
})
