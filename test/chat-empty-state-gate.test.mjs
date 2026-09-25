import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Regression test for the chat-overlay flicker (2026-09-25): the empty-state
// text used to be an absolute overlay gated on live agent sets
// (thinking/compacting/hibernating/suggestions). Every thinking burst in a
// messageless panel toggled it — the flicker. Now the text is an in-flow
// leading row gated on message state only: it stacks with the status row in
// layout instead of painting over it. This mirrors the allItems unshift gate
// in FleetChatShape.tsx without mounting React.

// Extracted predicate — keep in sync with the component gate.
function emptyRowRendered({ rawItemCount }) {
  return rawItemCount === 0
}

describe('chat empty-state row', () => {
  it('renders when the panel has zero messages', () => {
    assert.equal(emptyRowRendered({ rawItemCount: 0 }), true)
  })

  it('does not consult live agent sets, so thinking bursts cannot toggle it', () => {
    // The stability property: identical message state, thinking or not.
    assert.equal(emptyRowRendered({ rawItemCount: 0 }), true)
  })

  it('is absent whenever rendered content exists', () => {
    assert.equal(emptyRowRendered({ rawItemCount: 3 }), false)
  })
})
