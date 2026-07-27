#!/usr/bin/env node
// Proves the `await-fleet-store` lint rule still catches what it exists to catch.
//
// The rule is the thing standing between 400-odd call sites and a class of bug
// that does not throw: a missed `await` on a store call yields a Promise, a
// Promise is truthy, and every property on it is `undefined` — so `agent.dead`
// reads as ALIVE and live agents get reaped.
//
// A lint rule that silently stops matching looks exactly like a codebase with no
// violations. That failure would be silent and would remove the guard from every
// site at once, so the guard gets a guard. This runs in `npm run lint`, beside
// the other two, and costs milliseconds.
//
// It is not a test suite for the rule. It asserts two things: the catastrophic
// shape is rejected, and the shapes we deliberately allow are not — because a
// rule that fires on correct code gets disabled, and then it catches nothing.

import { Linter } from 'eslint'
import rule from '../eslint-rules/await-fleet-store.mjs'

const linter = new Linter()
const config = {
  plugins: { tlda: { rules: { 'await-fleet-store': rule } } },
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
  rules: { 'tlda/await-fleet-store': 'error' },
}

const wrap = (body) => `async function f(id, e) {\n${body}\n}\n`

// Must be REJECTED. Each is a way a promise gets treated as a value.
const MUST_CATCH = {
  'property read — the reaping bug': 'if (fleetStore.share(e).dead) return 1',
  'assigned, then used as an object': 'const a = fleetStore.share(e); return a.dead',
  'bare statement — looks like fire-and-forget': 'fleetStore.share(e)',
  'optional call — the form a grep misses': 'fleetStore?.share?.(e)',
  'passed as an argument': 'console.log(fleetStore.share(e))',
  'truthiness test': 'if (fleetStore.acknowledgeInboxRead(id)) return 2',
  'reached through a property': 'const s = { fleetStore }; s.fleetStore.share(e)',
}

// Must be ACCEPTED. Each hands the promise somewhere that handles one.
const MUST_ALLOW = {
  awaited: 'await fleetStore.share(e)',
  'awaited into a binding': 'const a = await fleetStore.share(e); return a.dead',
  returned: 'return fleetStore.share(e)',
  'explicit fire-and-forget': 'void fleetStore.share(e)',
  chained: 'fleetStore.share(e).catch(() => {})',
  'inside Promise.all': 'await Promise.all([fleetStore.share(e), fleetStore.share(e)])',
  'arrow body': 'return [e].map(x => fleetStore.share(x))',
  // Was `fleetStore.getAgent(id)`, chosen when the async list was a partial
  // set being grown one method at a time. The cutover finished: the list is now
  // the whole FleetStore manifest, so getAgent IS async and this fixture was
  // asserting the opposite. Replaced with a name the store genuinely does not
  // have, which is what the case was always testing — that the rule stays quiet
  // for something outside the manifest, rather than flagging every call on a
  // receiver named fleetStore.
  'a method not on the async list': 'const a = fleetStore.notAStoreMethodAtAll(id); return a.dead',
  'a different receiver entirely': 'const other = {}; other.share(e)',
  // Real shape in unified-server.mjs: adapt a maybe-promise, then handle it.
  'wrapped in Promise.resolve': 'Promise.resolve(fleetStore.share(e)).then(() => {})',
  'wrapped, optional-called': 'Promise.resolve(fleetStore?.share?.(e)).catch(() => {})',
}

const failures = []

for (const [label, body] of Object.entries(MUST_CATCH)) {
  const found = linter.verify(wrap(body), config)
  if (found.length === 0) failures.push(`NOT CAUGHT — ${label}\n      ${body}`)
}

for (const [label, body] of Object.entries(MUST_ALLOW)) {
  const found = linter.verify(wrap(body), config)
  if (found.length > 0) failures.push(`FALSE POSITIVE — ${label}\n      ${body}\n      ${found[0].message}`)
}

if (failures.length) {
  console.error('The await-fleet-store rule is not doing its job.')
  console.error('')
  console.error('It is the only thing preventing a missed `await` on a store call from')
  console.error('silently producing wrong fleet state — an un-awaited read is a truthy')
  console.error('Promise whose `.dead` is undefined, so a dead agent reads as alive.')
  console.error('')
  for (const f of failures) console.error(`  ${f}`)
  console.error('')
  console.error('Fix the rule. Do not delete this guard to make the message stop.')
  process.exit(1)
}

console.log(
  `await-fleet-store guard: rejects ${Object.keys(MUST_CATCH).length} unsafe shapes, ` +
  `allows ${Object.keys(MUST_ALLOW).length} safe ones`,
)
