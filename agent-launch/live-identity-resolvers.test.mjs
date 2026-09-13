import assert from 'node:assert/strict'
import test from 'node:test'
import { liveIdentityResolverMap } from './live-identity-resolvers.mjs'

test('the map contains every adapter that exports the resolver', () => {
  const map = liveIdentityResolverMap()
  for (const harness of ['claude', 'codex', 'muse']) {
    assert.equal(typeof map[harness], 'function', `${harness} exports a resolver so it must be in the map`)
  }
})

test('the map excludes an adapter with no such export', () => {
  const map = liveIdentityResolverMap({
    'fictional-harness': { resolveLiveSessionIdentity: async () => null },
    goose: { launch: async () => null },
  })
  assert.equal(typeof map['fictional-harness'], 'function', 'only derivation can produce a harness the implementation cannot know about')
  assert.ok(!('goose' in map), 'an adapter without the export must not be in the map')
})
