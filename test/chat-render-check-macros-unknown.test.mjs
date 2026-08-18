// The lint must not report a failed measurement as a fact about someone's setup.
//
// `checkChatRender` used to take `macros = {}`, and every failure upstream --
// a 2s fetch timeout, an unbuilt project, a non-ok response -- also produced
// `{}`. So "could not read your preamble" and "your preamble is empty" arrived
// identically, and the lint chose the second wording: "you have no project
// preamble set". An agent working in /Users/skip/work/bregman-lower-bound got
// that sentence while 56 macros sat in the project's artifact, made two
// redundant configuration() calls and filed a report. Skip set his preamble
// twice for the same reason.
//
// Its own words for what it wanted instead: "a correct instrument would have
// said 'macros didn't load' and I'd have shrugged and used plain LaTeX
// immediately."
import test from 'node:test'
import assert from 'node:assert/strict'

import { checkChatRender } from '../shared/chat-render-check.mjs'

const D = '$'
const PAPER_MATH = `We have ${D}\\E[\\ind{A}] = \\P(A)${D} as usual.`

test('an empty preamble is a measurement and still says so', () => {
  const issues = checkChatRender(PAPER_MATH, {}).validity
  assert.ok(issues.some(i => /you have no project preamble set/.test(i)),
    `expected the no-preamble wording, got ${JSON.stringify(issues)}`)
})

test('macros that could not be loaded must NOT claim the preamble is unset', () => {
  const issues = checkChatRender(PAPER_MATH, null).validity
  assert.ok(issues.length > 0, 'the undefined macro should still be reported')
  assert.ok(!issues.some(i => /you have no project preamble set/.test(i)),
    `must not assert an unmeasured cause, got ${JSON.stringify(issues)}`)
  assert.ok(issues.some(i => /could not be read/.test(i)),
    `expected the could-not-read wording, got ${JSON.stringify(issues)}`)
})

test('and it says the render may well be fine, because it may well be', () => {
  // The agent's next action differs: "set your preamble" is work, "this may be
  // fine" is a shrug. Getting that wrong is the whole cost of this bug.
  const issues = checkChatRender(PAPER_MATH, null).validity
  assert.ok(issues.some(i => /may render correctly/.test(i)),
    `expected the may-be-fine wording, got ${JSON.stringify(issues)}`)
})

test('a caller that measured nothing defaults to unknown, not to empty', () => {
  // daemon/local-artifacts.mjs calls checkChatRender(body) with no macros at
  // all. It never asked the server anything, so it is in no position to report
  // that a preamble is unset.
  const issues = checkChatRender(PAPER_MATH).validity
  assert.ok(!issues.some(i => /you have no project preamble set/.test(i)),
    `a caller with no macros argument has measured nothing, got ${JSON.stringify(issues)}`)
})

test('a loaded preamble still renders its macros and reports nothing', () => {
  const macros = { '\\E': '\\mathbb{E}', '\\ind': '\\mathbf{1}', '\\P': '\\mathbb{P}' }
  assert.deepEqual(checkChatRender(PAPER_MATH, macros).validity, [])
})

test('a genuinely broken formula is still a parse error, not a preamble hint', () => {
  const issues = checkChatRender(`Broken: ${D}\\frac{1}{${D} here`, null).validity
  assert.ok(issues.length > 0)
  assert.ok(!issues.some(i => /preamble/.test(i)),
    `a syntax error must not be blamed on macros, got ${JSON.stringify(issues)}`)
})
