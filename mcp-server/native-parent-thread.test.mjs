import assert from 'node:assert/strict'
import test from 'node:test'

import { matchesLocalParentThread } from './lib/native-parent-thread.mjs'

test('matches the MCP parent thread from either local identity source', () => {
  assert.equal(matchesLocalParentThread('claude-session', 'claude-session', null), true)
  assert.equal(matchesLocalParentThread('codex-thread', null, 'codex-thread'), true)
})

test('does not claim a native child thread as the parent', () => {
  assert.equal(matchesLocalParentThread('child-thread', 'parent-thread', 'parent-thread'), false)
  assert.equal(matchesLocalParentThread(null, 'parent-thread', 'parent-thread'), false)
})
