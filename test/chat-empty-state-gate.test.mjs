import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Regression test for the chat-overlay ghosting chase (2026-09-25):
// the empty-state "No filter set" text is an absolute overlay painted as a
// later sibling of AnchoredChatList. Gating it on chatMessages.length alone
// painted it over live thinking lines whenever a panel had zero messages but
// active status content. The gate must be: no rendered content AND no status
// content. This mirrors the statusRowEmpty + rawItems.length gate in
// FleetChatShape.tsx (empty-state block) without mounting React.

// Extracted predicate — keep in sync with the component gate.
function emptyStateVisible({ rawItemCount, thinking, compacting, hibernating, suggestions }) {
  const statusRowEmpty =
    thinking.length === 0 &&
    compacting.length === 0 &&
    hibernating.length === 0 &&
    suggestions.length === 0
  return rawItemCount === 0 && statusRowEmpty
}

describe('chat empty-state overlay gate', () => {
  const empty = { rawItemCount: 0, thinking: [], compacting: [], hibernating: [], suggestions: [] }

  it('shows when the panel is truly empty', () => {
    assert.equal(emptyStateVisible(empty), true)
  })

  it('hides while an agent is thinking with zero messages (the ghost)', () => {
    assert.equal(emptyStateVisible({ ...empty, thinking: ['fleet:abc'] }), false)
  })

  it('hides while compacting or hibernating with zero messages', () => {
    assert.equal(emptyStateVisible({ ...empty, compacting: ['fleet:abc'] }), false)
    assert.equal(emptyStateVisible({ ...empty, hibernating: ['fleet:abc'] }), false)
  })

  it('hides while a suggestion is pending with zero messages', () => {
    assert.equal(emptyStateVisible({ ...empty, suggestions: [{ label: 'hand off' }] }), false)
  })

  it('hides whenever rendered content exists, even with empty status', () => {
    assert.equal(emptyStateVisible({ ...empty, rawItemCount: 3 }), false)
  })
})
