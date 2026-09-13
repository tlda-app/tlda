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

// --- what real course content does, which the docs fixture could not show ---

test('a one-word correction is marked, not shown as two identical lines', () => {
  // His course, lectures/Lecture3.qmd, "fixed typo in L3": 13 words each side,
  // one word different. Whole-passage before/after rendered two matching lines.
  const change = summarizeChange(patch(
    '@@ -3,1 +3,1 @@\n' +
    '- Suppose we are calculating the probability of the response sequence.\n' +
    '+ Suppose we are computing the probability of the response sequence.\n',
  ))
  const marked = change.excerpt.beforeParts.filter(p => p.changed).map(p => p.text.trim())
  const markedAfter = change.excerpt.afterParts.filter(p => p.changed).map(p => p.text.trim())
  assert.deepEqual(marked, ['calculating'])
  assert.deepEqual(markedAfter, ['computing'])
  assert.ok(change.excerpt.beforeParts.some(p => !p.changed), 'the unchanged surround is still there')
})

test('a LaTeX command fix survives markup stripping', () => {
  // `\ldot` -> `\ldots`. proseOf turns BOTH into a space, so stripping erased
  // the whole change and the card showed two identical lines. Measured on his
  // course before this guard existed.
  const change = summarizeChange(patch(
    '@@ -3,1 +3,1 @@\n' +
    '-- Suppose the sequence $a_1 \\ldot a_n = 0$.\n' +
    '++ Suppose the sequence $a_1 \\ldots a_n = 0$.\n',
  ))
  assert.notEqual(change.excerpt.before, change.excerpt.after, 'the two sides must differ')
  const after = change.excerpt.afterParts.filter(p => p.changed).map(p => p.text.trim()).join(' ')
  assert.match(after, /\\ldots/, 'the command that changed is the marked span')
})

test('the raw fallback does not fire when stripping kept the difference', () => {
  const change = summarizeChange(patch(
    '@@ -3,1 +3,1 @@\n' +
    '-\\emph{The estimator} is consistent.\n' +
    '+\\emph{The estimator} is efficient.\n',
  ))
  assert.ok(!change.excerpt.before.includes('\\emph'), 'ordinary prose stays stripped')
})

test('a change beyond the clip window is still what the excerpt shows', () => {
  // Measured on a paper of his: a correction ~500 characters into a long
  // passage. Clipping the first N characters and marking afterwards gave two
  // byte-identical windows with no marks -- the same failure as not marking.
  const lead = Array.from({ length: 120 }, (_, i) => `lead${i}`).join(' ')
  const change = summarizeChange(patch(
    '@@ -3,1 +3,1 @@\n' +
    `-${lead} the estimator is consistent.\n` +
    `+${lead} the estimator is efficient.\n`,
  ), { excerptChars: 120 })
  assert.ok(change.excerpt.before.startsWith('…'), 'the window moved off the start and says so')
  assert.match(change.excerpt.before, /consistent/, 'the changed span is inside the window')
  assert.match(change.excerpt.after, /efficient/)
  assert.ok(change.excerpt.afterParts.some(p => p.changed && /efficient/.test(p.text)))
})
