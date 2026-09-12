// Regression: the fleet-chat composer must DISPLAY and SEND the same agent.
// Both the send hint and the keyboard/voice payload derive from one resolver
// (uniqueLiveAgentForLabel / bindSendTargetId). This guards the invariant that
// the recipient shown to the user is exactly the agent whose id is delivered —
// so a phase-suffixed name, a name collision, or an ambiguous selector can never
// silently route to a different agent than the one displayed.
import assert from 'node:assert/strict'
import {
  uniqueLiveAgentForLabel,
  bindSendTargetId,
  inboxConversationRecipientId,
  indexSelectedAgentRecipientId,
} from '../src/fleet/send-target-binding.mjs'

let failed = false
try {
  const coordinator = { id: 'fleet:11111111', friendly_name: 'project-coordinator:day', labels: ['tlda'], human: false, dead: false, runtime_status: { kind: 'ai', status: 'awake' } }
  const helper = { id: 'fleet:22222222', friendly_name: 'helper-agent', labels: ['tlda'], human: false, dead: false, runtime_status: { kind: 'ai', status: 'awake' } }
  const agents = [coordinator, helper]

  // Core invariant: displayed name and bound payload id come from the SAME agent.
  for (const label of ['project-coordinator:day', 'helper-agent', 'fleet:11111111']) {
    const shownAgent = uniqueLiveAgentForLabel(label, agents)
    const payloadId = bindSendTargetId(label, agents)
    assert.ok(shownAgent, `"${label}" must resolve to an agent`)
    assert.equal(payloadId, shownAgent.id,
      `displayed agent and payload id must be the same object for "${label}"`)
  }

  // A phase-suffixed friendly name binds to its holder's immutable id (the fix:
  // the payload is the id, not the colon name the server would mis-parse).
  assert.equal(bindSendTargetId('project-coordinator:day', agents), 'fleet:11111111')
  assert.equal(uniqueLiveAgentForLabel('project-coordinator:day', agents).id, 'fleet:11111111',
    'phase name must never resolve to a different agent (e.g. helper-agent)')

  // Ambiguous selector (a label two agents share) does NOT bind to one id — it
  // passes through as an expression so it fans out server-side, never silently
  // picking one of them.
  assert.equal(uniqueLiveAgentForLabel('tlda', agents), null, 'shared label is not a single recipient')
  assert.equal(bindSendTargetId('tlda', agents), 'tlda', 'ambiguous label passes through unbound')

  // Name collision: a dead namesake plus a live holder resolves to the LIVE one,
  // and binds to the live holder's id.
  const deadTwin = { id: 'fleet:dead-twin', friendly_name: 'helper-agent', labels: [], human: false, dead: true, runtime_status: { kind: 'ai', status: 'dead' } }
  const collided = [deadTwin, helper]
  assert.equal(uniqueLiveAgentForLabel('helper-agent', collided).id, 'fleet:22222222',
    'live holder wins over dead namesake')
  assert.equal(bindSendTargetId('helper-agent', collided), 'fleet:22222222')

  // An unknown name binds to nothing resolvable — it passes through so the send
  // hits the server and fails visibly (0 recipients), never silently.
  assert.equal(uniqueLiveAgentForLabel('nobody-here', agents), null)
  assert.equal(bindSendTargetId('nobody-here', agents), 'nobody-here')

  // Inbox ConversationView symmetry: the DM composer sends the partner's
  // immutable id, NEVER the mutable friendly name — same canonical-ID contract
  // as the main composer, so a name/phase change can't silently misroute it.
  const thread = { partnerId: 'fleet:11111111', partnerName: 'coordinator', friendly: 'project-coordinator:day' }
  assert.equal(inboxConversationRecipientId(thread), 'fleet:11111111',
    'inbox must send the partner id')
  assert.notEqual(inboxConversationRecipientId(thread), thread.friendly,
    'inbox must never send the mutable friendly name')
  assert.equal(inboxConversationRecipientId({}), null, 'no partner id → null (guarded, not a wrong send)')

  // Project-index top chat symmetry: the selected row is already the target.
  // Send to its immutable id, never to the display/exact name that can be
  // renamed, phase-suffixed, or otherwise re-resolved by the server.
  const indexRow = { id: 'fleet:33333333', exactName: 'outline-helper', displayName: 'outline-helper' }
  assert.equal(indexSelectedAgentRecipientId(indexRow), 'fleet:33333333',
    'index top chat must send the selected row id')
  assert.notEqual(indexSelectedAgentRecipientId(indexRow), indexRow.exactName,
    'index top chat must never send the mutable selected-row name')
  assert.equal(indexSelectedAgentRecipientId(null), null, 'no selected row → null')

  console.log('PASS chat-send-target-binding-regression-test')
} catch (e) {
  failed = true
  console.error('FAIL', e.message)
  console.error(e.stack)
}
process.exit(failed ? 1 : 0)
