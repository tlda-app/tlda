// Regression: the fleet-chat composer must DISPLAY and SEND the same agent.
// Both the send hint and the keyboard/voice payload derive from one resolver
// (uniqueLiveAgentForLabel / bindSendTargetId). This guards the invariant that
// the recipient shown to the user is exactly the agent whose id is delivered —
// so a phase-suffixed name, a name collision, or an ambiguous selector can never
// silently route to a different agent than the one displayed.
import assert from 'node:assert/strict'
import { uniqueLiveAgentForLabel, bindSendTargetId, inboxConversationRecipientId } from '../src/fleet/send-target-binding.mjs'

let failed = false
try {
  const chiefdoc = { id: 'fleet:921026ec', friendly_name: 'chiefdoc-coordinator-sol:day', labels: ['tlda'], human: false, dead: false, runtime_status: { status: 'awake' } }
  const sol = { id: 'fleet:30028dba', friendly_name: 'sol-introspection', labels: ['tlda'], human: false, dead: false, runtime_status: { status: 'awake' } }
  const agents = [chiefdoc, sol]

  // Core invariant: displayed name and bound payload id come from the SAME agent.
  for (const label of ['chiefdoc-coordinator-sol:day', 'sol-introspection', 'fleet:921026ec']) {
    const shownAgent = uniqueLiveAgentForLabel(label, agents)
    const payloadId = bindSendTargetId(label, agents)
    assert.ok(shownAgent, `"${label}" must resolve to an agent`)
    assert.equal(payloadId, shownAgent.id,
      `displayed agent and payload id must be the same object for "${label}"`)
  }

  // A phase-suffixed friendly name binds to its holder's immutable id (the fix:
  // the payload is the id, not the colon name the server would mis-parse).
  assert.equal(bindSendTargetId('chiefdoc-coordinator-sol:day', agents), 'fleet:921026ec')
  assert.equal(uniqueLiveAgentForLabel('chiefdoc-coordinator-sol:day', agents).id, 'fleet:921026ec',
    'phase name must never resolve to a different agent (e.g. sol-introspection)')

  // Ambiguous selector (a label two agents share) does NOT bind to one id — it
  // passes through as an expression so it fans out server-side, never silently
  // picking one of them.
  assert.equal(uniqueLiveAgentForLabel('tlda', agents), null, 'shared label is not a single recipient')
  assert.equal(bindSendTargetId('tlda', agents), 'tlda', 'ambiguous label passes through unbound')

  // Name collision: a dead namesake plus a live holder resolves to the LIVE one,
  // and binds to the live holder's id.
  const deadTwin = { id: 'fleet:dead-twin', friendly_name: 'sol-introspection', labels: [], human: false, dead: true, runtime_status: { status: 'dead' } }
  const collided = [deadTwin, sol]
  assert.equal(uniqueLiveAgentForLabel('sol-introspection', collided).id, 'fleet:30028dba',
    'live holder wins over dead namesake')
  assert.equal(bindSendTargetId('sol-introspection', collided), 'fleet:30028dba')

  // An unknown name binds to nothing resolvable — it passes through so the send
  // hits the server and fails visibly (0 recipients), never silently.
  assert.equal(uniqueLiveAgentForLabel('nobody-here', agents), null)
  assert.equal(bindSendTargetId('nobody-here', agents), 'nobody-here')

  // Inbox ConversationView symmetry: the DM composer sends the partner's
  // immutable id, NEVER the mutable friendly name — same canonical-ID contract
  // as the main composer, so a name/phase change can't silently misroute it.
  const thread = { partnerId: 'fleet:921026ec', partnerName: 'chiefdoc', friendly: 'chiefdoc-coordinator-sol:day' }
  assert.equal(inboxConversationRecipientId(thread), 'fleet:921026ec',
    'inbox must send the partner id')
  assert.notEqual(inboxConversationRecipientId(thread), thread.friendly,
    'inbox must never send the mutable friendly name')
  assert.equal(inboxConversationRecipientId({}), null, 'no partner id → null (guarded, not a wrong send)')

  console.log('PASS chat-send-target-binding-regression-test')
} catch (e) {
  failed = true
  console.error('FAIL', e.message)
  console.error(e.stack)
}
process.exit(failed ? 1 : 0)
