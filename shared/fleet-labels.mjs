/**
 * fleet-labels.mjs — single source of truth for "what labels does an agent
 * answer to" and "does a DNF filter match a label set".
 *
 * Before this module the label-expansion logic was hand-copied in six places
 * (client display `agentMatchesLabel`, client history `resolveFilter`, client
 * send `resolveToFleetId(s)`, the server chat router, the server wiretap
 * matcher, and eliza). The copies had already drifted — e.g. `resolveFilter`
 * dropped the `human`/`human-away` pseudo-labels, so a chat scoped to `human`
 * showed live messages but returned empty backfilled history (the same class
 * of bug as the lineage-agent scrollback issue). One resolver kills that.
 *
 * Imported by both the server (.mjs, Node) and the bundled client
 * (src/fleet/fleet-data.mjs, src/shapes/FleetChatShape.tsx via Vite) — keep it
 * dependency-free.
 *
 * Inputs are *hydrated* agent objects (fleet-store `_hydrateAgent`): they carry
 * `status` (awake|hibernating|human|human-away|dead), parsed `labels`,
 * `friendly_name`, `id`, `lineage_name`, and `phase`. The client receives the
 * same shape over /api/state and the WS push.
 */

/**
 * The reserved routing labels derived from an agent's status. A friendly_name
 * or explicit label may not collide with these (see fleet-store name checks).
 */
export const PSEUDO_LABELS = Object.freeze(['awake', 'hibernating', 'human', 'human-away'])

/** Pseudo-labels implied by an agent's status. */
export function statusLabels(status) {
  switch (status) {
    case 'awake': return ['awake']
    case 'hibernating': return ['hibernating']
    case 'human': return ['human']
    case 'human-away': return ['human', 'human-away']
    default: return []
  }
}

/**
 * The full set of labels a (hydrated) agent answers to, for chat routing,
 * filtering, and history resolution.
 *
 * Includes: explicit labels[], status pseudo-labels, friendly_name, id. Phase
 * is encoded in the friendly name ("base:day"/"base:dusk"; dawn is the bare
 * base), so the phase-qualified address is already covered by friendly_name.
 * Each agent answers ONLY to its own full name — the base name does NOT fan out
 * to the whole lineage. Lineage is a name-rotation convention, a search gloss,
 * and a graphical overlay; it is not a chat-routing label.
 */
export function labelsForAgent(agent) {
  if (!agent) return []
  const out = [
    ...(agent.labels || []),
    ...statusLabels(agent.status),
    agent.friendly_name,
    agent.id,
  ]
  return out.filter(Boolean)
}

/**
 * Evaluate a DNF filter (array of AND-clauses) against a precomputed label set.
 * A term is either a `[role, label]` tuple or a bare string label; the role is
 * ignored here (directional from/to selection is the caller's responsibility —
 * see `matchesFilter`). An empty/absent filter matches everything.
 */
export function evalDnf(filter, labels) {
  if (!filter || filter.length === 0) return true
  const set = Array.isArray(labels) ? labels : []
  return filter.some(clause =>
    Array.isArray(clause) && clause.every(term =>
      set.includes(Array.isArray(term) ? term[1] : term),
    ),
  )
}
