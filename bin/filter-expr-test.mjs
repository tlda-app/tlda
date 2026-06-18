#!/usr/bin/env node
// Unit tests for the filter-expression engine (shared/fleet-labels.mjs):
// parseFilter (string -> AST) + evalExpr (AST + label set -> bool).
// Run: node bin/filter-expr-test.mjs

import { parseFilter, evalExpr, matchFilter, validateDnfFilter, evalDirectionalDnf } from '../shared/fleet-labels.mjs'

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
function dnfOk(filter, opts = {}) {
  try { validateDnfFilter(filter, opts); pass++ }
  catch (e) { fail++; console.log(`FAIL  expected DNF ok for ${JSON.stringify(filter)}: ${e.message}`) }
}
function dnfErr(filter, opts = {}) {
  try { validateDnfFilter(filter, opts); fail++; console.log(`FAIL  expected DNF throw for ${JSON.stringify(filter)}`) }
  catch { pass++ }
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

// --- malformed input throws (no silent match-all) ---
terr('a &')
terr('a & & b')
terr('(a | b')
terr(') a')
terr('a b')      // two literals, no operator
terr(['fleet:skip'])  // a stray array must fail loud, not be mishandled

// --- DNF validation / directional eval ---
dnfOk([[['from', 'fleet:skip']]], { directional: true })
dnfOk([[['from', 'fleet:skip'], ['to', 'awake']]], { directional: true })
dnfErr('fleet:skip', { directional: true })
dnfErr([[['sender', 'fleet:skip']]], { directional: true })
dnfErr([[['from', '']]], { directional: true })
dnfErr([[['from']]], { directional: true })
if (evalDirectionalDnf([[['from', 'math'], ['to', 'human']]], { fromLabels: ['math'], toLabels: ['human', 'fleet:skip'] }) !== true) {
  fail++; console.log('FAIL  directional DNF should match from/to labels')
} else pass++
if (evalDirectionalDnf([[['from', 'math'], ['to', 'goose']]], { fromLabels: ['math'], toLabels: ['human'] }) !== false) {
  fail++; console.log('FAIL  directional DNF should reject missing to label')
} else pass++

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
