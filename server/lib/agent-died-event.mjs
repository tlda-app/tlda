// F4: deaths by the mark-only paths emit a lifecycle event naming the actor,
// as the kill paths already do. Shaped on the killEvent precedent
// (type/from/to/text via share); the caller-supplied actor follows the label
// route's body-field precedent.
//
// Honesty baked into the shape (chief-apprentice amend): route auth is
// shared-secret, so no authenticated actor identity exists at either call
// site. A supplied actor is self-asserted, never authenticated — provenance
// says so explicitly, so no future consumer can read `from` as verified
// identity.

export const AGENT_DIED_TYPE = 'agent-died'

export function buildAgentDiedEvent({ agentId, path, actor = null, serverOwnerId }) {
  const claimed = (typeof actor === 'string' && actor.trim()) ? actor.trim() : null
  return {
    type: AGENT_DIED_TYPE,
    from: claimed || serverOwnerId,
    to: agentId,
    text: `Agent ${agentId} marked dead via ${path}`,
    metadata: {
      path,
      actor: claimed,
      actor_provenance: claimed ? 'self-asserted' : 'server',
    },
  }
}

export async function emitAgentDiedEvent({ share, agentId, path, actor = null, serverOwnerId }) {
  return share(buildAgentDiedEvent({ agentId, path, actor, serverOwnerId }))
}
