#!/usr/bin/env node
// Unit tests for the filter-expression engine (shared/fleet-labels.mjs):
// parseFilter (string -> AST) + evalExpr (AST + label set -> bool).
// Run: node tests/filter-expr.test.mjs

import { parseFilter, evalExpr, matchFilter, evalExprDirectional } from '../shared/fleet-labels.mjs'

let pass = 0, fail = 0
const L = (...a) => a

function t(filter, labels, want) {
  let got
  try { got = matchFilter(filter, labels) } catch (e) { got = 'ERR:' + e.message }
  if (got === want) pass++
  else { fail++; console.log(`FAIL  ${JSON.stringify(filter)} on ${JSON.stringify(labels)} => ${got} (want ${want})`) }
}
function terr(filter) {
  try { parseFilter(filter); fail++; console.log(`FAIL  expected throw for ${JSON.stringify(filter)}`) }
  catch { pass++ }
}
// Directional eval: parse the string expression, eval against from/to label sets.
function td(filter, ctx, want) {
  let got
  try { got = evalExprDirectional(parseFilter(filter), ctx) } catch (e) { got = 'ERR:' + e.message }
  if (got === want) pass++
  else { fail++; console.log(`FAIL  dir ${JSON.stringify(filter)} on ${JSON.stringify(ctx)} => ${got} (want ${want})`) }
}

// --- single token ---
t('fleet:skip', L('fleet:skip'), true)
t('fleet:skip', L('fleet:dmitry'), false)
t('awake', L('awake', 'mathy'), true)
t('awake', L('hibernating'), false)

// --- AND ---
t('awake & mathy', L('awake', 'mathy'), true)
t('awake & mathy', L('awake'), false)

// --- OR ---
t('fleet:skip | ops', L('ops'), true)
t('fleet:skip | ops', L('nobody'), false)

// --- NOT ---
t('mathy & !goose', L('mathy'), true)
t('mathy & !goose', L('mathy', 'goose'), false)
t('!goose', L('mathy'), true)
t('!goose', L('goose'), false)

// --- precedence: & binds tighter than | ---
t('a | b & c', L('a'), true)       // a OR (b AND c)
t('a | b & c', L('b'), false)
t('a | b & c', L('b', 'c'), true)

// --- parens override ---
t('(a | b) & c', L('a'), false)
t('(a | b) & c', L('a', 'c'), true)

// --- colon / dash tokens ---
t('human-away', L('human', 'human-away'), true)
t('fleet:mini-mgr', L('fleet:mini-mgr'), true)

// --- empty = match all ---
t('', L('anything'), true)
t('   ', L(), true)

// --- Set label collections ---
if (evalExpr(parseFilter('a & b'), new Set(['a', 'b'])) !== true) { fail++; console.log('FAIL  Set labels') } else pass++

// --- message filters support implicit AND ---
t('a b', L('a', 'b'), true)
t('a b', L('a'), false)

// --- malformed input throws (no silent match-all) ---
terr('a &')
terr('a & & b')
terr('(a | b')
terr(') a')
terr(['fleet:skip'])  // a stray array must fail loud, not be mishandled

// --- directional string-expression eval (wiretap) ---
// to:/from: leaf prefixes select the side; bare token matches either side.
td('to:skip & from:math', { fromLabels: ['math'], toLabels: ['skip'] }, true)
td('to:skip & from:math', { fromLabels: ['math'], toLabels: ['human'] }, false) // no to:skip
td('to:skip & from:math', { fromLabels: ['ops'], toLabels: ['skip'] }, false)    // no from:math
td('from:math', { fromLabels: ['math'], toLabels: [] }, true)
td('from:math', { fromLabels: [], toLabels: ['math'] }, false)                   // math is recipient, not sender
td('to:math', { fromLabels: ['math'], toLabels: [] }, false)
// bare token = involves-either-side
td('skip', { fromLabels: ['skip'], toLabels: ['x'] }, true)
td('skip', { fromLabels: ['x'], toLabels: ['skip'] }, true)
td('skip', { fromLabels: ['x'], toLabels: ['y'] }, false)
// OR / NOT compose directionally
td('to:apps | from:ops', { fromLabels: ['ops'], toLabels: ['y'] }, true)
td('from:goose & !to:skip', { fromLabels: ['goose'], toLabels: ['dmitry'] }, true)
td('from:goose & !to:skip', { fromLabels: ['goose'], toLabels: ['skip'] }, false)
// Set label collections work too
if (evalExprDirectional(parseFilter('to:skip'), { fromLabels: new Set(['m']), toLabels: new Set(['skip']) }) !== true) {
  fail++; console.log('FAIL  directional Set labels')
} else pass++
// null AST (empty filter) matches everything
if (evalExprDirectional(null, { fromLabels: ['a'], toLabels: ['b'] }) !== true) {
  fail++; console.log('FAIL  null directional AST should match all')
} else pass++

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
