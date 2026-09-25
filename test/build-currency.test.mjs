import assert from 'node:assert/strict'
import test from 'node:test'
import { buildAgeLabel, describeBuildCurrency, shortRevision } from '../src/pills/build-currency.mjs'

const R1 = 'abc1234567'
const R2 = 'def5678901'

test('equal sequences read as current and quiet', () => {
  const v = describeBuildCurrency({
    renderedRevision: R1, renderedSeq: 3, savedRevision: R1, savedSeq: 3,
    status: 'success', lastBuild: new Date(Date.now() - 240_000).toISOString(),
  })
  assert.equal(v.state, 'current')
  assert.equal(v.loud, false)
  assert.match(v.label, /rendered abc1234.*saved abc1234/)
  assert.match(v.label, /built 4m ago/)
})

test('diverged sequences with no build running are loudly stale-dead', () => {
  const v = describeBuildCurrency({
    renderedRevision: R1, renderedSeq: 3, savedRevision: R2, savedSeq: 4,
    status: 'success', lastBuild: new Date().toISOString(),
  })
  assert.equal(v.state, 'stale-dead')
  assert.equal(v.loud, true)
  assert.match(v.label, /STALE/)
  assert.match(v.label, /no following build/)
})

test('diverged sequences while building are quiet stale-building, never red', () => {
  const v = describeBuildCurrency({
    renderedRevision: R1, renderedSeq: 3, savedRevision: R2, savedSeq: 4,
    status: 'building', lastBuild: new Date().toISOString(),
  })
  assert.equal(v.state, 'stale-building')
  assert.equal(v.loud, false)
  assert.doesNotMatch(v.label, /STALE/)
})

test('equal sequences while building are quiet building, not stale', () => {
  const v = describeBuildCurrency({
    renderedRevision: R1, renderedSeq: 4, savedRevision: R1, savedSeq: 4,
    status: 'building', lastBuild: new Date().toISOString(),
  })
  assert.equal(v.state, 'building')
  assert.equal(v.loud, false)
  assert.doesNotMatch(v.label, /STALE/)
})

test('a failed newest build is loud and names the last success', () => {
  const v = describeBuildCurrency({
    renderedRevision: R1, renderedSeq: 3, savedRevision: R2, savedSeq: 4,
    status: 'error', lastBuild: new Date().toISOString(),
  })
  assert.equal(v.state, 'failed')
  assert.equal(v.loud, true)
  assert.match(v.label, /last success/)
})

test('saves with no render are loudly unbuilt', () => {
  const v = describeBuildCurrency({
    renderedRevision: null, renderedSeq: null, savedRevision: R2, savedSeq: 1,
    status: 'unknown', lastBuild: null,
  })
  assert.equal(v.state, 'unbuilt')
  assert.equal(v.loud, true)
})

test('revision text decides when no sequences exist', () => {
  const v = describeBuildCurrency({
    renderedRevision: 'aaa1111111', renderedSeq: null,
    savedRevision: 'bbb2222222', savedSeq: null,
    status: 'success', lastBuild: new Date().toISOString(),
  })
  assert.equal(v.state, 'stale-dead')
  assert.equal(v.loud, true)
})

test('a save-side sequence with no rendered side is stale, never current', () => {
  const v = describeBuildCurrency({
    renderedRevision: null, renderedSeq: null, savedRevision: null, savedSeq: 2,
    status: 'success', lastBuild: new Date().toISOString(),
  })
  assert.notEqual(v.state, 'current')
  assert.equal(v.loud, true)
})

test('buildAgeLabel names never-built and scales units', () => {
  assert.equal(buildAgeLabel(null), 'never built')
  assert.equal(buildAgeLabel('not-a-date'), 'built at unknown time')
  assert.match(buildAgeLabel(new Date(Date.now() - 30_000).toISOString()), /built 30s ago/)
  assert.match(buildAgeLabel(new Date(Date.now() - 5 * 3_600_000).toISOString()), /built 5h ago/)
})

test('shortRevision ignores unknown and blank', () => {
  assert.equal(shortRevision('unknown'), null)
  assert.equal(shortRevision('  '), null)
  assert.equal(shortRevision(R1), 'abc1234')
})
