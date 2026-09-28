import assert from 'node:assert/strict'
import test from 'node:test'

import {
  anchorChatScrollPosition,
  chatScrollContentEnd,
  chatScrollStartOf,
  chatScrollStoreKey,
  createRestoreOwnership,
  decideScrollRestore,
  nextRestoreOwnership,
  readChatScrollState,
  resolveChatScrollRestore,
  restoreCommitSupersedes,
  shouldSkipGoToTail,
  writeChatScrollState,
} from '../src/shapes/chatViewportAnchor.mjs'

// Scroll restoration across reload: the panel persists an anchor (the topmost
// visible item key + pixel offset) and restores to it on the next mount, so a
// reader scrolled up to a card is still looking at it after a reload instead
// of landing at the tail.

const FILTER = '[[["from","x"]]]'

function heights(entries) {
  const m = new Map(entries)
  return (key) => m.get(key) ?? 80
}

test('store key is namespaced per panel', () => {
  assert.equal(chatScrollStoreKey('shape:abc'), 'tlda:chat-scroll:v1:shape:abc')
})

test('anchor at top is the first key with zero offset', () => {
  const out = anchorChatScrollPosition(['a', 'b', 'c'], heights([['a', 100]]), 0)
  assert.deepEqual(out, { anchorKey: 'a', anchorOffset: 0 })
})

test('anchor mid-list names the intersecting key with its offset', () => {
  // a:[0,100) b:[100,180) c:[180,260); modelTop 150 is 50px into b.
  const out = anchorChatScrollPosition(['a', 'b', 'c'], heights([['a', 100], ['b', 80]]), 150)
  assert.deepEqual(out, { anchorKey: 'b', anchorOffset: 50 })
})

test('anchor uses the estimated height for unmeasured rows', () => {
  const out = anchorChatScrollPosition(['a', 'b'], heights([]), 90)
  assert.deepEqual(out, { anchorKey: 'b', anchorOffset: 10 })
})

test('anchor past the end has nothing to persist', () => {
  assert.equal(anchorChatScrollPosition(['a'], heights([['a', 100]]), 100), null)
  assert.equal(anchorChatScrollPosition([], heights([]), 0), null)
  assert.equal(anchorChatScrollPosition(['a'], heights([['a', 100]]), -5), null)
})

test('start-of-key walks the same accumulation the list geometry uses', () => {
  const h = heights([['a', 100], ['b', 80]])
  assert.equal(chatScrollStartOf(['a', 'b', 'c'], h, 'a'), 0)
  assert.equal(chatScrollStartOf(['a', 'b', 'c'], h, 'b'), 100)
  assert.equal(chatScrollStartOf(['a', 'b', 'c'], h, 'c'), 180)
  assert.equal(chatScrollStartOf(['a', 'b', 'c'], h, 'zzz'), null)
})

test('content end totals the same walk', () => {
  const h = heights([['a', 100], ['b', 80]])
  assert.equal(chatScrollContentEnd(['a', 'b', 'c'], h), 260)
  assert.equal(chatScrollContentEnd([], h), 0)
})

test('restore resolves anchor start plus offset', () => {
  const saved = { v: 1, filterKey: FILTER, tail: false, anchorKey: 'b', anchorOffset: 50 }
  const starts = new Map([['a', 0], ['b', 100], ['c', 180]])
  assert.equal(resolveChatScrollRestore(saved, FILTER, (k) => starts.get(k)), 150)
})

test('restore refuses a filter change, a tail record, and a missing key', () => {
  const starts = new Map([['a', 0], ['b', 100]])
  const startOf = (k) => starts.get(k)
  assert.equal(resolveChatScrollRestore(
    { v: 1, filterKey: 'other', tail: false, anchorKey: 'b', anchorOffset: 0 }, FILTER, startOf), null)
  assert.equal(resolveChatScrollRestore(
    { v: 1, filterKey: FILTER, tail: true }, FILTER, startOf), null)
  assert.equal(resolveChatScrollRestore(
    { v: 1, filterKey: FILTER, tail: false, anchorKey: 'zzz', anchorOffset: 0 }, FILTER, startOf), null)
})

test('restore refuses malformed records', () => {
  const startOf = () => 0
  assert.equal(resolveChatScrollRestore(null, FILTER, startOf), null)
  assert.equal(resolveChatScrollRestore('x', FILTER, startOf), null)
  assert.equal(resolveChatScrollRestore({ v: 2, filterKey: FILTER, anchorKey: 'a', anchorOffset: 0 }, FILTER, startOf), null)
  assert.equal(resolveChatScrollRestore({ v: 1, filterKey: FILTER, anchorKey: '', anchorOffset: 0 }, FILTER, startOf), null)
  assert.equal(resolveChatScrollRestore({ v: 1, filterKey: FILTER, anchorKey: 'a', anchorOffset: -1 }, FILTER, startOf), null)
  assert.equal(resolveChatScrollRestore({ v: 1, filterKey: FILTER, anchorKey: 'a', anchorOffset: '50' }, FILTER, startOf), null)
})

function fakeStorage() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)) },
    _raw: (k, v) => { m.set(k, v) },
  }
}

test('storage round-trips the saved state', () => {
  const storage = fakeStorage()
  const key = chatScrollStoreKey('shape:abc')
  const state = { v: 1, filterKey: FILTER, tail: false, anchorKey: 'b', anchorOffset: 50 }
  assert.equal(writeChatScrollState(storage, key, state), true)
  assert.deepEqual(readChatScrollState(storage, key), state)
})

test('storage read tolerates missing and corrupt records', () => {
  const storage = fakeStorage()
  assert.equal(readChatScrollState(storage, chatScrollStoreKey('shape:abc')), null)
  storage._raw(chatScrollStoreKey('shape:abc'), '{nope')
  assert.equal(readChatScrollState(storage, chatScrollStoreKey('shape:abc')), null)
  storage._raw(chatScrollStoreKey('shape:abc'), '"just-a-string"')
  assert.equal(readChatScrollState(storage, chatScrollStoreKey('shape:abc')), null)
})

// A pending restore retries across mount settling: the first population may
// precede the synced filter or the anchored row, so a single refusal must
// hold rather than fall to the tail.

function decide(saved, resetKey, atTail, starts, maxTop) {
  const map = new Map(starts)
  return decideScrollRestore({ saved, resetKey, atTail, startOf: (k) => map.get(k), maxTop })
}

const ANCHORED = { v: 1, filterKey: FILTER, tail: false, anchorKey: 'b', anchorOffset: 50 }

test('pending restore jumps when the filter matches and the key is present', () => {
  assert.deepEqual(
    decide(ANCHORED, FILTER, true, [['a', 0], ['b', 100]]),
    { action: 'restore', top: 150, reason: 'restore' },
  )
})

test('pending restore holds while the filter is still settling', () => {
  assert.deepEqual(decide(ANCHORED, '[]', true, [['b', 100]]), { action: 'hold', reason: 'filter-settling' })
  assert.deepEqual(decide(ANCHORED, '', true, [['b', 100]]), { action: 'hold', reason: 'filter-settling' })
  assert.deepEqual(decide(ANCHORED, null, true, [['b', 100]]), { action: 'hold', reason: 'filter-settling' })
})

test('pending restore holds while the anchored row has not arrived', () => {
  assert.deepEqual(decide(ANCHORED, FILTER, true, [['a', 0]]), { action: 'hold', reason: 'key-missing' })
  assert.deepEqual(decide(ANCHORED, FILTER, true, []), { action: 'hold', reason: 'key-missing' })
})

test('pending restore abandons on a genuine filter change', () => {
  assert.deepEqual(
    decide(ANCHORED, '[[["from","someone-else"]]]', true, [['b', 100]]),
    { action: 'abandon', reason: 'filter-changed' },
  )
})

test('pending restore abandons once the reader moves off the tail', () => {
  assert.deepEqual(
    decide(ANCHORED, FILTER, false, [['a', 0], ['b', 100]]),
    { action: 'abandon', reason: 'not-at-tail' },
  )
})

test('pending restore abandons records that can never resolve', () => {
  const starts = [['a', 0], ['b', 100]]
  assert.deepEqual(decide(null, FILTER, true, starts), { action: 'abandon', reason: 'no-saved' })
  assert.deepEqual(decide('x', FILTER, true, starts), { action: 'abandon', reason: 'no-saved' })
  assert.deepEqual(decide({ ...ANCHORED, v: 2 }, FILTER, true, starts), { action: 'abandon', reason: 'version' })
  assert.deepEqual(decide({ ...ANCHORED, tail: true }, FILTER, true, starts), { action: 'abandon', reason: 'saved-tail' })
  assert.deepEqual(decide({ ...ANCHORED, filterKey: '' }, FILTER, true, starts), { action: 'abandon', reason: 'saved-filter-empty' })
  assert.deepEqual(decide({ ...ANCHORED, anchorKey: '' }, FILTER, true, starts), { action: 'abandon', reason: 'anchor-key-empty' })
  assert.deepEqual(decide({ ...ANCHORED, anchorOffset: -1 }, FILTER, true, starts), { action: 'abandon', reason: 'anchor-offset-bad' })
  assert.deepEqual(decide({ ...ANCHORED, anchorOffset: '50' }, FILTER, true, starts), { action: 'abandon', reason: 'anchor-offset-bad' })
})

test('pending restore holds while the target is past the committable tail', () => {
  const starts = [['a', 0], ['b', 100]]
  assert.deepEqual(
    decide(ANCHORED, FILTER, true, starts, 100),
    { action: 'hold', reason: 'beyond-tail', top: 150 },
  )
})

test('pending restore fires once the target is inside the committable tail', () => {
  const starts = [['a', 0], ['b', 100]]
  assert.deepEqual(
    decide(ANCHORED, FILTER, true, starts, 150),
    { action: 'restore', top: 150, reason: 'restore' },
  )
  assert.deepEqual(
    decide(ANCHORED, FILTER, true, starts, 1000),
    { action: 'restore', top: 150, reason: 'restore' },
  )
})

test('absent maxTop preserves restore behavior exactly', () => {
  const starts = [['a', 0], ['b', 100]]
  assert.deepEqual(
    decide(ANCHORED, FILTER, true, starts, undefined),
    { action: 'restore', top: 150, reason: 'restore' },
  )
})

// Restore ownership: the list owns positioning from adoption through the
// post-commit settle window, and the parent's filter-reset effect yields to
// it. This replaces reading the persisted record, which the mount persist
// overwrites before the parent reads.

test('ownership starts clear and adoption takes it', () => {
  assert.deepEqual(createRestoreOwnership(), { owns: false, committed: false })
  assert.deepEqual(nextRestoreOwnership(createRestoreOwnership(), 'adopt'), { owns: true, committed: false })
})

test('ownership survives the commit and clears when the settle window elapses', () => {
  const adopted = nextRestoreOwnership(createRestoreOwnership(), 'adopt')
  const committed = nextRestoreOwnership(adopted, 'commit')
  assert.deepEqual(committed, { owns: true, committed: true })
  assert.deepEqual(nextRestoreOwnership(committed, 'settle-elapsed'), { owns: false, committed: false })
})

test('ownership clears on abandon', () => {
  const adopted = nextRestoreOwnership(createRestoreOwnership(), 'adopt')
  assert.deepEqual(nextRestoreOwnership(adopted, 'abandon'), { owns: false, committed: false })
  const committed = nextRestoreOwnership(adopted, 'commit')
  assert.deepEqual(nextRestoreOwnership(committed, 'abandon'), { owns: false, committed: false })
})

test('a genuine filter change clears ownership through abandon', () => {
  const decision = decide(ANCHORED, '[[["from","other"]]]', true, [['a', 0], ['b', 100]])
  assert.equal(decision.action, 'abandon')
  const adopted = nextRestoreOwnership(createRestoreOwnership(), 'adopt')
  assert.deepEqual(nextRestoreOwnership(adopted, decision.action), { owns: false, committed: false })
})

test('ownership ignores commit and settle without adoption', () => {
  const fresh = createRestoreOwnership()
  assert.deepEqual(nextRestoreOwnership(fresh, 'commit'), fresh)
  assert.deepEqual(nextRestoreOwnership(fresh, 'settle-elapsed'), fresh)
  assert.deepEqual(nextRestoreOwnership(fresh, 'bogus'), fresh)
})

test('filter-change yields while a restore owns positioning', () => {
  assert.equal(shouldSkipGoToTail('filter-change', true), true)
  assert.equal(shouldSkipGoToTail('filter-change', false), false)
})

test('a user-initiated jump still tails while a restore owns positioning', () => {
  assert.equal(shouldSkipGoToTail('jump-button', true), false)
  assert.equal(shouldSkipGoToTail('jump-button', false), false)
})

test('a restore commit supersedes only a filter-change loop', () => {
  assert.equal(restoreCommitSupersedes('filter-change'), true)
  assert.equal(restoreCommitSupersedes('jump-button'), false)
  assert.equal(restoreCommitSupersedes(undefined), false)
})
