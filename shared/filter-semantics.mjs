import { labelsForAgent, evalExprDirectional } from './fleet-labels.mjs'
import { runtimeStatusName } from './fleet-runtime-status.mjs'

// The set of labels a participant (an event's from/to/agent id) answers to.
// Label expansion has a single source of truth — `labelsForAgent` in
// shared/fleet-labels.mjs, the same function the server uses — so client and
// server agree on "does agent X carry label L". A bare id with no roster entry
// still answers to its own id (preserving the old `agentId === label` case).
function labelSetForParticipant(agentId, {
  agents = [], participantLabels = null, humanId = null, humanName = null,
} = {}) {
  if (!agentId) return new Set()
  const atEvent = participantLabels instanceof Map
    ? participantLabels.get(agentId)
    : participantLabels?.[agentId]
  if (atEvent) return new Set(atEvent)
  let agent = agents.find(a => a.id === agentId)
  if (!agent && humanId && agentId === humanId) {
    agent = { id: humanId, friendly_name: humanName || 'user', runtime_status: { status: 'human' }, labels: [] }
  }
  return new Set(agent ? labelsForAgent(agent) : [agentId])
}

function agentMatchesLabel(agentId, label, context = {}) {
  return labelSetForParticipant(agentId, context).has(label)
}

function isHumanParticipant(agentId, context) {
  return agentMatchesLabel(agentId, context.humanId, context) ||
    (context.humanName ? agentMatchesLabel(agentId, context.humanName, context) : false)
}

function isDmWithTarget(event, targetLabel, context) {
  if (!event || !targetLabel) return false
  if (event._activity || event.type === 'activity') {
    // The target agent's OWN activity belongs in the "DM ⚒ / tools visible" rung
    // (dm, normal traffic). The quiet rung (dm-quiet) hides it via
    // quietTrafficSuppressesActivity at the render layer, NOT here — so this gate
    // must let it through, scoped strictly to the target's own activity. Other
    // agents' activity stays excluded from a DM filter.
    const actor = event.from || event.from_id || event.agent || event.agent_id || null
    return agentMatchesLabel(actor, targetLabel, context)
  }
  const from = event.from || event.from_id || event.agent
  const to = event.to || event.to_id || null
  const agent = event.agent || event.agent_id || null
  const fromHuman = isHumanParticipant(from, context)
  const toHuman = isHumanParticipant(to, context)
  const fromTarget = agentMatchesLabel(from, targetLabel, context)
  const toTarget = agentMatchesLabel(to, targetLabel, context) || agentMatchesLabel(agent, targetLabel, context)

  if (fromHuman && toTarget) return true
  if (fromTarget && toHuman) return true
  if (fromTarget && !to) return true
  return false
}

// Filter is DNF of terms: [[["to","skip"],["from","math"]]] or plain [["label"]] or null (match all).
// Term formats: [role, label] tuple (directional) or plain string (matches from OR to).
//
// The directional label matching is evaluated by the SHARED engine —
// `evalExprDirectional` from shared/fleet-labels.mjs, the same evaluator the
// server uses for wiretap (`to:`/`from:`/bare leaves) — so a `[role,label]`
// tuple and the server's `role:label` string expression resolve identically.
// We hand the evaluator a single-leaf AST node directly (not a constructed
// string) so labels containing spaces or `&|!()` can't be mis-tokenized. The
// only client-specific term is `dm`, an event-level predicate (it needs the
// human's identity and the from/to/empty-to shape) that has no server
// counterpart, so it stays a local pre-check rather than a shared leaf.
function leafNode(token) { return { t: 'lit', v: token } }

export function matchesFleetFilter(filter, event, context = {}) {
  if (!event) return true  // broadcast (e.g. read-receipt refresh)
  if (!filter || filter.length === 0) return true
  if ((event.from_id === 'system' || event.from === 'system') && !event.to) return true
  // Accept the store's field names as well as the normalised ones. Events
  // reaching the SERVER come straight off fleet-store (from_id/to_id); events
  // reaching the CLIENT have been through convertChatEvent, which renames them
  // to from/to. Reading only the normalised pair made every server-side
  // evaluation resolve an undefined participant, so no name term could ever
  // match — eventsMatched stayed 0 across 1,620 live evaluations.
  // isDmWithTarget below already read both; this path did not. One file, two
  // conventions.
  const fromLabels = labelSetForParticipant(event.from || event.from_id || event.agent, context)
  const toLabels = labelSetForParticipant(event.to || event.to_id || event.agent, context)
  const dirCtx = { fromLabels, toLabels }
  const matchTerm = (term) => {
    if (Array.isArray(term)) {
      const [role, label] = term
      if (role === 'dm') return isDmWithTarget(event, label, context)
      // [from,x] -> "from:x", [to,x] -> "to:x" leaf for the shared evaluator.
      return evalExprDirectional(leafNode(`${role}:${label}`), dirCtx)
    }
    // Plain string — bare leaf matches from OR to (shared evaluator semantics).
    return evalExprDirectional(leafNode(term), dirCtx)
  }
  return filter.some(clause => clause.every(matchTerm))
}

function termLabel(term) {
  return Array.isArray(term) ? term[1] : term
}

export function fleetFilterLabels(filter) {
  const labels = new Set()
  for (const clause of filter || []) {
    if (!Array.isArray(clause)) continue
    for (const term of clause) {
      const label = termLabel(term)
      if (label) labels.add(label)
    }
  }
  return labels
}

// Resolve a DNF filter to the broad set of agent IDs needed to fetch history for
// events that might match the live display filter. The history endpoint only
// prefilters by "involves one of these agents", so include every referenced
// participant label instead of requiring one agent to satisfy an entire clause.
export function resolveFleetFilter(filter, { agents = [], humanId = null, humanName = null } = {}) {
  if (!filter) return new Set()
  const ids = new Set()
  const allAgents = [...agents]
  if (humanId && !allAgents.some(a => a.id === humanId)) {
    allAgents.push({ id: humanId, friendly_name: humanName || 'user', runtime_status: { status: 'human' }, labels: [] })
  }
  const labels = fleetFilterLabels(filter)
  for (const label of labels) {
    if (label.startsWith('fleet:')) ids.add(label)
  }
  // Resolve a shared name to the LIVE holder. Skip's model: "dying makes the name
  // usable, it does not wipe it" — a dead agent keeps its name, so dead+live name
  // duplicates are the steady state. A label that ANY live agent carries must
  // resolve to the live holder(s) ONLY: a dead namesake keeping the same name
  // must not pull its (historical) thread into a filter aimed at the live agent
  // (that's what broke Skip's filter). A label with NO live holder still resolves
  // to the dead one, so a fully-dead name's history stays reachable. Ids are
  // unique, so explicit id-targeting is unaffected.
  const liveLabels = new Set()
  for (const a of allAgents) {
    if (a.dead) continue
    for (const l of labelsForAgent(a)) liveLabels.add(l)
  }
  for (const a of allAgents) {
    const agentLabels = labelsForAgent(a)
    const matched = [...labels].some(label =>
      agentLabels.includes(label) && (!a.dead || !liveLabels.has(label)))
    if (matched) ids.add(a.id)
  }
  return ids
}

export function buildFleetDmFilter(humanLabel, agentLabel) {
  if (!agentLabel) return []
  return [[['dm', agentLabel]]]
}

export function buildFleetAgentFilter(agentLabel) {
  if (!agentLabel) return []
  return [
    [['from', agentLabel]],
    [['to', agentLabel]],
  ]
}

function findAgentById(agents, id) {
  if (!id) return null
  return (agents || []).find(agent => agent?.id === id) || null
}

function isHumanAgentId(id, { agents = [], humanId = null } = {}) {
  if (!id) return false
  if (humanId && id === humanId) return true
  const agent = findAgentById(agents, id)
  const status = runtimeStatusName(agent)
  return !!agent?.human || status === 'human' || status === 'human-away'
}

export function fleetSearchResultParticipantLabel(result, participantId, context = {}) {
  if (!result || !participantId) return ''
  const liveAgent = findAgentById(context.agents, participantId)
  if (liveAgent?.friendly_name) return liveAgent.friendly_name

  if (participantId === (result.agentId || result.agent)) {
    const ownerName = result.agentNameNow || result.agentName
    if (ownerName) return ownerName
  }
  if (participantId === result.from) {
    const fromName = result.fromNameNow || result.fromName
    if (fromName) return fromName
  }
  if (participantId === result.to) {
    const toName = result.toNameNow || result.toName
    if (toName) return toName
  }
  return ''
}

export function fleetSearchResultTargetAgentLabel(result, context = {}) {
  if (!result) return ''
  const ownerId = result.agentId || result.agent || ''
  if (!isHumanAgentId(ownerId, context)) {
    const owningName = fleetSearchResultParticipantLabel(result, ownerId, context)
    if (owningName) return owningName
  }

  for (const participant of [result.from, result.to]) {
    if (isHumanAgentId(participant, context)) continue
    const participantName = fleetSearchResultParticipantLabel(result, participant, context)
    if (participantName) return participantName
  }

  return ''
}

export function fleetSearchResultAgentChatFilter(result, context = {}) {
  const label = fleetSearchResultTargetAgentLabel(result, context)
  return label ? buildFleetAgentFilter(label) : []
}

function canonicalFilter(filter) {
  if (!Array.isArray(filter)) return ''
  return filter
    .map(clause => Array.isArray(clause)
      ? clause.map(term => Array.isArray(term) ? `${term[0]}\0${term[1]}` : `any\0${term}`).sort().join('\u0001')
      : '')
    .sort()
    .join('\u0002')
}

export function sameFleetFilter(a, b) {
  return canonicalFilter(a) === canonicalFilter(b)
}

export function quietTrafficSuppressesActivity(filter, trafficMode) {
  if (trafficMode !== 'quiet') return false
  return Array.isArray(filter) && filter.some((clause) =>
    Array.isArray(clause) && clause.some((term) => Array.isArray(term) && term[0] === 'dm')
  )
}

function inferFleetComposerTrafficModeFromFilter(filter, trafficMode) {
  if (!Array.isArray(filter)) return 'custom'
  const dmLabel = filter.length === 1 &&
    Array.isArray(filter[0]) &&
    filter[0].length === 1 &&
    Array.isArray(filter[0][0]) &&
    filter[0][0][0] === 'dm'
      ? filter[0][0][1]
      : ''
  if (dmLabel) return trafficMode === 'quiet' ? 'dm-quiet' : 'dm'

  const labels = new Set()
  for (const clause of filter) {
    if (!Array.isArray(clause) || clause.length !== 1 || !Array.isArray(clause[0])) return 'custom'
    const [role, label] = clause[0]
    if (role !== 'from' && role !== 'to') return 'custom'
    labels.add(label)
  }
  const roles = new Set(filter.map((clause) => clause[0][0]))
  return filter.length === 2 && labels.size === 1 && roles.has('from') && roles.has('to') ? 'agent' : 'custom'
}

export function classifyFleetComposerTrafficMode(filter, trafficMode, humanLabel, agentLabel) {
  if (!agentLabel) return inferFleetComposerTrafficModeFromFilter(filter, trafficMode)
  if (sameFleetFilter(filter, buildFleetDmFilter(humanLabel, agentLabel))) {
    return trafficMode === 'quiet' ? 'dm-quiet' : 'dm'
  }
  if (sameFleetFilter(filter, buildFleetAgentFilter(agentLabel))) return 'agent'
  return 'custom'
}

export function nextFleetComposerTrafficMode(currentMode) {
  if (currentMode === 'dm-quiet') return 'dm'
  if (currentMode === 'dm') return 'agent'
  return 'dm-quiet'
}

export function filterForFleetComposerTrafficMode(mode, humanLabel, agentLabel) {
  return mode === 'agent'
    ? buildFleetAgentFilter(agentLabel)
    : buildFleetDmFilter(humanLabel, agentLabel)
}
