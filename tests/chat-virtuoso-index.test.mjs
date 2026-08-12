import test from 'node:test'
import assert from 'node:assert/strict'
import {
  VIRTUOSO_STATUS_ITEM_KEY,
  nextChatVirtuosoFirstItemIndex,
} from '../src/shapes/chatVirtuosoIndex.mjs'

test('chat virtuoso index preserves item coordinates when history is prepended', () => {
  assert.equal(
    nextChatVirtuosoFirstItemIndex(1_000_000, ['a', 'b'], ['x', 'y', 'a', 'b']),
    999_998,
  )
})

test('chat virtuoso index preserves item coordinates when old rows are trimmed from the head', () => {
  assert.equal(
    nextChatVirtuosoFirstItemIndex(999_998, ['x', 'y', 'a', 'b'], ['a', 'b', 'c']),
    1_000_000,
  )
})

test('chat virtuoso index ignores the synthetic status row as an anchor', () => {
  assert.equal(
    nextChatVirtuosoFirstItemIndex(
      1_000_000,
      [VIRTUOSO_STATUS_ITEM_KEY],
      ['a', 'b', VIRTUOSO_STATUS_ITEM_KEY],
    ),
    1_000_000,
  )
})
