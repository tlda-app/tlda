// send-target-binding — the ONE resolver the fleet-chat composer uses both to
// DISPLAY the recipient (the send hint) and to bind the payload's canonical id
// (keyboard + voice send). Because display and delivery derive from the same
// resolved agent object, the shown target and the delivered target can never be
// different agents — the contract Skip requires.
import { labelsForAgent } from '../../shared/fleet-labels.mjs'

/**
 * The single live agent a send-target label addresses, or null when it does not
 * uniquely resolve — an empty/unknown name, or a broadcast selector that matches
 * many agents (those keep their expression form and fan out server-side).
 *
 * Resolution order (mirrors how a person addresses an agent):
 *  - a `fleet:` id → that exact agent;
 *  - the exact full route name (friendly_name, or name, or id) → its holder,
 *    preferring a LIVE holder over a dead namesake (a dead agent keeps its name
 *    for provenance, so name↔holder is many-to-one; the live holder IS the
 *    agent, and an all-dead name still resolves so resurrect-by-name works);
 *  - otherwise a carried label, but only when exactly ONE non-human agent
 *    carries it (an ambiguous label is a broadcast, not a single recipient).
 */
export function uniqueLiveAgentForLabel(label, agentList) {
  if (!label) return null
  const agents = agentList || []
  if (label.startsWith('fleet:')) return agents.find(a => a.id === label) || null
  const byName = agents.filter(a => (a?.friendly_name || a?.name || a?.id) === label || a.id === label)
  if (byName.length) return byName.find(a => !a.dead) || byName[0]
  const matched = agents.filter(a => !a.human && labelsForAgent(a).includes(label))
  return matched.length === 1 ? matched[0] : null
}

/**
 * Bind a display label to the canonical immutable id to SEND. Returns the exact
 * agent's `fleet:` id when the label uniquely resolves; otherwise returns the
 * label unchanged (broadcast selectors keep their expression form).
 */
export function bindSendTargetId(label, agentList) {
  const agent = uniqueLiveAgentForLabel(label, agentList)
  return agent ? agent.id : label
}

/**
 * The recipient id an inbox ConversationView sends to. A conversation is a DM
 * with exactly one partner whose immutable id the thread already carries, so the
 * send MUST use that id — never the mutable friendly name — so the shown partner
 * and the delivered recipient are the same agent object (same contract as the
 * main composer's id-binding). Returns null when no partner id is present.
 */
export function inboxConversationRecipientId(thread) {
  return thread?.partnerId ?? null
}
