import assert from 'node:assert/strict'
import test from 'node:test'
import { identityIsDiscoveredAfterLaunch } from './index.mjs'
import { liveIdentityResolverMap } from './live-identity-resolvers.mjs'

// The real map, not a fixture list. A fixture would keep passing after an
// adapter gained or lost `resolveLiveSessionIdentity`, which is exactly the
// drift this gate is supposed to track.
const resolvers = liveIdentityResolverMap()

// claude is the only harness we mint an id for, and `freshSessionId` is that
// id. Everything else discovers its id after launch.
const freshFor = kind => (kind === 'claude' ? '0199f000-0000-7000-8000-000000000001' : null)

const gate = kind => identityIsDiscoveredAfterLaunch({
  requestedKind: kind,
  freshSessionId: freshFor(kind),
  resolvers,
})

test('discovery runs for the harnesses whose id is only knowable once running', () => {
  // muse is the fix: it discovers, it has a resolver, and the gate used to
  // read `requestedKind === 'codex'` so it never ran. No session id meant
  // mint-core returned early and the binding never wrote daemonKey.
  assert.equal(gate('muse'), true)
  assert.equal(gate('codex'), true)
})

test('discovery does not run for a harness whose id we minted ourselves', () => {
  // claude HAS a resolver, so a gate written as "does this harness have a
  // resolver" would newly turn discovery on for it -- a behaviour change on
  // the mint path for the most-used harness, which this asserts against.
  assert.ok(resolvers.claude, 'claude has a resolver, which is why the freshSessionId condition is needed')
  assert.equal(gate('claude'), false)
})

test('discovery does not run for a harness nothing can resolve', () => {
  // goose discovers nothing; polling it would run to the deadline and return
  // null. `bot` likewise has no resolver.
  assert.equal(resolvers.goose, undefined)
  assert.equal(gate('goose'), false)
  assert.equal(gate('bot'), false)
})

test('an unknown harness is excluded rather than admitted by default', () => {
  assert.equal(gate('something-nobody-has-written-yet'), false)
})

// The precise regression. Written as a table so the next change to this gate
// has to state what it does to every harness, rather than checking the one it
// cares about -- an enumeration is a claim, and the previous one was short by
// the entry that mattered.
test('exactly one harness changes behaviour, and it is muse', () => {
  const before = kind => kind === 'codex' // the harness-name gate this replaced
  const changed = ['claude', 'codex', 'muse', 'goose', 'bot']
    .filter(kind => before(kind) !== gate(kind))
  assert.deepEqual(changed, ['muse'])
})
