// Filter subscriptions: a chat is a filter, and the server answers it.
//
// A connection registers (subId, filter). Every event is evaluated ONCE per
// DISTINCT filter — not once per connection and not once per panel — and
// delivered to the subscriptions whose filter matched. Nineteen panels sharing
// four distinct filters cost four evaluations, not nineteen.
//
// Evaluation uses shared/filter-semantics.mjs, the same module the browser
// runs, against this filter instance's temporal participant table. Live events
// extend it forward with their participant state; history pages extend it only
// across the time interval they query. A present-day roster is never projected
// backward onto an old message.
//
// This module owns no sockets and no clock. It is given a connection handle to
// key by and hands back the handles that matched, so it can be tested without
// a server.
//
// LIFECYCLE IS THE CALLER'S. `byConn` is keyed by the connection object, so a
// caller that does not wire `dropConnection` into its socket close path retains
// every socket it ever saw. The module cannot enforce this and deliberately
// does not try — but it is the one obligation that comes with handing it a
// handle.

import { matchesFleetFilter, fleetFilterLabels, filterLabelsForAgent } from '../../shared/filter-semantics.mjs'
import { labelsForAgent } from '../../shared/fleet-labels.mjs'

/** Canonical key for a DNF filter, so equal filters share one evaluation. */
export function filterKey(filter) {
  if (!filter || !Array.isArray(filter) || filter.length === 0) return ''
  // Sort within each clause and across clauses: `a & b` and `b & a` are the
  // same filter and must not evaluate twice.
  const clauses = filter
    .map((clause) => (Array.isArray(clause) ? [...clause].map(termKey).sort() : []))
    .map((terms) => terms.join(','))
    .sort()
  return clauses.join('|')
}

/** Identity key for dm: scoping — both halves, since both are load-bearing. */
function humanKeyOf(sub) {
  return `${sub.humanId || ''}\u0000${sub.humanName || ''}`
}

function termKey(term) {
  if (Array.isArray(term)) return `${term[0]}:${term[1]}`
  return String(term)
}

/**
 * Cut a history range into blocks over which the filter's agent set is FIXED.
 *
 * Membership only changes at a span endpoint, so those endpoints are the only
 * places a block can begin or end. Within a block the agent list is EXACT — it
 * is the right list, not a candidate set the predicate narrows afterwards.
 * Resolving over the whole range instead would produce a superset and throw that
 * property away, which is the mistake this function exists to make impossible.
 *
 * Newest first, matching the direction history is read. `to: null` means "now",
 * `from: null` means "the beginning", so the blocks tile the range with no gap
 * for a row to fall through.
 *
 * A block can legitimately come back with no agents: nobody held the filter's
 * labels then. That is exact, not a failure — nothing in that range can match.
 */
export function membershipBlocks(spans, labels, { before = null, humanId = null, viewerIsNamed = false } = {}) {
  const labelSet = new Set(labels || [])
  const relevant = (spans || []).filter(span => labelSet.has(span?.label) && span?.fleet_id)
  const points = new Set()
  for (const span of relevant) {
    if (span.from_ts && (!before || span.from_ts < before)) points.add(span.from_ts)
    if (span.to_ts && (!before || span.to_ts < before)) points.add(span.to_ts)
  }
  const edges = [before ?? null, ...[...points].sort().reverse()]
  // A fleet id named directly by the filter belongs to every block: it is not
  // label membership and does not change at a boundary.
  //
  // The VIEWER's id belongs only when the filter actually reaches for it —
  // `dm:` is scoped by identity, and `me` names the viewer. Adding it
  // unconditionally widens every block beyond the agents holding the filter's
  // labels, which is the superset this function exists to avoid: for a
  // high-volume viewer it fills the page with rows the predicate then rejects.
  const always = new Set()
  for (const label of labelSet) if (String(label).startsWith('fleet:')) always.add(label)
  if (humanId && (viewerIsNamed || labelSet.has('me') || labelSet.has(humanId))) always.add(humanId)

  const blocks = []
  for (let i = 0; i < edges.length; i++) {
    const to = edges[i]
    const from = edges[i + 1] ?? null
    const agentIds = new Set(always)
    for (const span of relevant) {
      if (to && span.from_ts >= to) continue
      if (from && span.to_ts && span.to_ts <= from) continue
      agentIds.add(span.fleet_id)
    }
    blocks.push({ from, to, agentIds: [...agentIds] })
  }
  return blocks
}

class TemporalMembership {
  constructor(filter) {
    this.labels = fleetFilterLabels(filter)
    this.current = new Map([...this.labels].map(label => [label, new Set()]))
    this.intervals = new Map([...this.labels].map(label => [label, []]))
    this.spanKeys = new Set()
    this.covered = []
  }

  observe(agents) {
    for (const agent of agents || []) {
      if (!agent?.id) continue
      for (const ids of this.current.values()) ids.delete(agent.id)
      const expanded = new Set(filterLabelsForAgent(agent, agents))
      for (const label of this.labels) {
        if (expanded.has(label)) this.current.get(label).add(agent.id)
      }
    }
  }

  extend(spans, from, to) {
    for (const span of spans || []) {
      if (!this.labels.has(span?.label) || !span?.fleet_id || !span?.from_ts) continue
      const key = `${span.label}\0${span.fleet_id}\0${span.from_ts}\0${span.to_ts || ''}`
      if (this.spanKeys.has(key)) continue
      this.spanKeys.add(key)
      this.intervals.get(span.label).push(span)
    }
    this.covered.push({ from, to })
  }

  participantLabels(event, { live = false } = {}) {
    const ids = [...new Set([
      event?.from, event?.from_id, ...(event?.recipients || []),
      event?.agent, event?.agent_id,
    ].filter(Boolean))]
    const out = Object.create(null)
    for (const id of ids) {
      const labels = new Set([id])
      for (const label of this.labels) {
        if (live) {
          if (this.current.get(label)?.has(id)) labels.add(label)
          continue
        }
        const timestamp = event?.timestamp
        if (!timestamp) continue
        const spans = this.intervals.get(label) || []
        if (spans.some(span =>
          span.fleet_id === id &&
          span.from_ts <= timestamp &&
          (!span.to_ts || timestamp < span.to_ts)
        )) labels.add(label)
      }
      out[id] = [...labels]
    }
    return out
  }
}

export function createFilterSubscriptions({ getAgentsByIds, loadMembershipSpans } = {}) {
  if (typeof getAgentsByIds !== 'function') {
    throw new Error('createFilterSubscriptions requires getAgentsByIds()')
  }
  if (typeof loadMembershipSpans !== 'function') {
    throw new Error('createFilterSubscriptions requires loadMembershipSpans()')
  }

  // key -> { filter, subs: Map<subKey, {conn, subId, humanId, humanName}> }
  const byFilter = new Map()
  // conn -> Set<subKey>, so a closed socket drops every subscription it held.
  const byConn = new Map()

  const subKeyOf = (conn, subId) => `${connId(conn)}\u0000${subId}`
  let nextConnId = 1
  const connIds = new WeakMap()
  function connId(conn) {
    let id = connIds.get(conn)
    if (!id) { id = `c${nextConnId++}`; connIds.set(conn, id) }
    return id
  }

  function subscribe(conn, subId, filter, { humanId = null, humanName = null, eventTypes = null } = {}) {
    if (!conn || !subId) return null
    const normalizedEventTypes = Array.isArray(eventTypes)
      ? [...new Set(eventTypes.filter(type => typeof type === 'string' && type))].sort()
      : []
    const baseKey = filterKey(filter)
    const key = normalizedEventTypes.length
      ? `${baseKey}\u0000${normalizedEventTypes.join(',')}`
      : baseKey
    let entry = byFilter.get(key)
    if (!entry) {
      entry = {
        filter,
        eventTypes: new Set(normalizedEventTypes),
        subs: new Map(),
        temporal: new TemporalMembership(filter),
        deliveries: 0,
        lastDeliveryAt: null,
      }
      byFilter.set(key, entry)
    }
    const sk = subKeyOf(conn, subId)
    // Re-subscribing an existing subId REPLACES it. Without this, a panel that
    // refilters keeps its old entry under the old filterKey — so it matches
    // both filters and receives every qualifying event twice. Refiltering is
    // the workaround people reach for when a panel looks stuck, which is
    // exactly when a duplicate-delivery bug would land.
    //
    // Re-sending the SAME filter (the identity-refresh path) is unaffected:
    // same filterKey means same entry, and the set() below overwrites in place.
    for (const [otherKey, otherEntry] of byFilter) {
      if (otherKey === key) continue
      if (otherEntry.subs.delete(sk)) {
        const keys = byConn.get(conn)
        if (keys) {
          let stillHeld = false
          for (const sub of otherEntry.subs.values()) {
            if (sub.conn === conn) { stillHeld = true; break }
          }
          if (!stillHeld) keys.delete(otherKey)
        }
        if (otherEntry.subs.size === 0) byFilter.delete(otherKey)
      }
    }
    entry.subs.set(sk, { conn, subId, humanId, humanName })
    let keys = byConn.get(conn)
    if (!keys) { keys = new Set(); byConn.set(conn, keys) }
    keys.add(key)
    return key
  }

  function unsubscribe(conn, subId) {
    const sk = subKeyOf(conn, subId)
    const keys = byConn.get(conn)
    for (const [key, entry] of byFilter) {
      if (!entry.subs.delete(sk)) continue
      // Drop the key from this connection's set once it holds no sub on it.
      // Without this, byConn only ever grows for a long-lived socket whose
      // panels open, close, and refilter — the set-that-only-adds shape.
      if (keys) {
        let stillHeld = false
        for (const sub of entry.subs.values()) {
          if (sub.conn === conn) { stillHeld = true; break }
        }
        if (!stillHeld) keys.delete(key)
      }
      if (entry.subs.size === 0) byFilter.delete(key)
    }
    if (keys && keys.size === 0) byConn.delete(conn)
    return true
  }

  /** Drop everything a closed connection held. Called from the socket's close. */
  function dropConnection(conn) {
    const keys = byConn.get(conn)
    if (!keys) return 0
    let dropped = 0
    for (const key of keys) {
      const entry = byFilter.get(key)
      if (!entry) continue
      for (const [sk, sub] of entry.subs) {
        if (sub.conn === conn) { entry.subs.delete(sk); dropped++ }
      }
      if (entry.subs.size === 0) byFilter.delete(key)
    }
    byConn.delete(conn)
    return dropped
  }

  // The one place an evaluation context is built. participantLabels is the
  // event-time join result owned by this filter instance.
  function evalContext(participantLabels, humanId, humanName) {
    return { participantLabels, humanId, humanName }
  }

  /**
   * Does this event belong in this filter, for this subscriber?
   * Exposed so the live and history paths can be asserted to agree on real
   * traffic rather than merely being capable of agreeing.
   */
  async function verdict(filter, event, {
    humanId = null, humanName = null, participantLabels = null,
  } = {}) {
    let labels = participantLabels
    if (!labels) {
      const temporal = new TemporalMembership(filter)
      const agents = Array.isArray(event?._filter_agents)
        ? event._filter_agents
        : await getAgentsByIds([
          event?.from, event?.from_id, ...(event?.recipients || []),
          event?.agent, event?.agent_id,
        ].filter(Boolean)) || []
      temporal.observe(agents)
      labels = temporal.participantLabels(event, { live: true })
    }
    if (humanId) {
      const humanLabels = new Set(labels?.[humanId] || [humanId])
      humanLabels.add(humanId)
      humanLabels.add('human')
      if (humanName) humanLabels.add(humanName)
      labels = { ...labels, [humanId]: [...humanLabels] }
    }
    return matchesFleetFilter(filter, event, evalContext(labels, humanId, humanName))
  }

  /**
   * Evaluate one event against every distinct filter.
   * Returns [{ conn, subId }] for the subscriptions that matched.
   * `evaluations` on the returned array reports how many filters were run —
   * the number that must stay near the distinct-filter count, not the
   * subscription count.
   */
  async function match(event) {
    const out = []
    let evaluations = 0
    let eventAgents = null
    for (const entry of byFilter.values()) {
      if (entry.subs.size === 0) continue
      if (entry.eventTypes.size && !entry.eventTypes.has(event?.type)) continue
      if (eventAgents === null) {
        eventAgents = Array.isArray(event?._filter_agents)
          ? event._filter_agents
          : await getAgentsByIds([
            event?.from, event?.from_id, ...(event?.recipients || []),
            event?.agent, event?.agent_id,
          ].filter(Boolean)) || []
      }
      entry.temporal.observe(eventAgents)
      const participantLabels = entry.temporal.participantLabels(event, { live: true })
      evaluations++
      // Identity scopes `dm:`, and both halves matter: humanId for the id path
      // and humanName for the name path. Key on the pair.
      const humanKeys = new Set()
      for (const sub of entry.subs.values()) humanKeys.add(humanKeyOf(sub))
      if (humanKeys.size === 1) {
        const first = entry.subs.values().next().value
        if (await verdict(entry.filter, event, { ...first, participantLabels })) {
          entry.deliveries += entry.subs.size
          entry.lastDeliveryAt = new Date().toISOString()
          for (const sub of entry.subs.values()) out.push({ conn: sub.conn, subId: sub.subId })
        }
        continue
      }
      const verdicts = new Map()
      for (const sub of entry.subs.values()) {
        const hk = humanKeyOf(sub)
        if (!verdicts.has(hk)) {
          if (verdicts.size > 0) evaluations++
          verdicts.set(hk, await verdict(entry.filter, event, { ...sub, participantLabels }))
        }
        if (verdicts.get(hk)) {
          entry.deliveries += 1
          entry.lastDeliveryAt = new Date().toISOString()
          out.push({ conn: sub.conn, subId: sub.subId })
        }
      }
    }
    out.evaluations = evaluations
    return out
  }

  /**
   * History, decided by the same predicate as live push.
   *
   * A database must narrow candidates with an index — that is a performance
   * concern, not a membership decision. The membership decision is verdict(),
   * the same call live push makes. If this function could answer
   * "belongs / doesn't" on its own, live and history could disagree, which is
   * exactly how they came to drop different sets of protocol messages.
   *
   * queryPage({ before, agentIds, limit }) -> rows, newest-first. It is the
   * caller's SQL; this function never interprets it beyond ordering.
   *
   * BLOCKS, NOT GUESSES. Membership is constant between two label-change
   * events, so the range cuts at span endpoints into blocks over which the
   * filter's agent set is exact. The query is a disjunction over those
   * (time range, agent set) pairs, so the database returns rows involving the
   * right agents instead of everything in the range.
   *
   * The predicate still decides — which clause matched, the negatives, `dm:`
   * scoping are not "involves one of these agents" — but it is no longer handed
   * a time range's worth of rows to say no to.
   *
   * What this replaces: `agentIds: []` plus a page-size loop whose growth was
   * written as exponential and clamped flat (400, 400, 800, 1000, then 21 more
   * passes at 1000), reading up to ~23,600 rows to return 100. That loop existed
   * only to compensate for asking the database the wrong question.
   */
  async function history(filter, {
    humanId = null, humanName = null, before = null, limit = 50,
    queryPage, maxPasses = 25,
  } = {}) {
    if (typeof queryPage !== 'function') throw new Error('history requires queryPage()')
    const entry = byFilter.get(filterKey(filter))
    const temporal = entry?.temporal || new TemporalMembership(filter)
    const labels = [...temporal.labels]

    // Every span that could touch this filter at or before the cursor. Their
    // endpoints are the label-change events, and so the block boundaries.
    const spans = await loadMembershipSpans(labels, { from: null, to: before })
    temporal.extend(spans, null, before)
    // `dm:` is scoped by the viewer's identity, so its rows involve them even
    // though no label names them. That is the one case the viewer's own id
    // belongs in the block's agent list.
    const viewerIsNamed = (filter || []).some(clause =>
      Array.isArray(clause) && clause.some(term => Array.isArray(term) && term[0] === 'dm'))
    const blocks = membershipBlocks(spans, labels, { before, humanId, viewerIsNamed })

    const kept = []
    let cursor = before
    let exhausted = false
    let reads = 0

    // Narrowing to the right agents does not make the predicate a no-op: which
    // clause matched, the negatives and `dm:` scoping are still its decision, so
    // a page can come back short with matching rows still older. Continue from
    // the last row EXAMINED until the page fills or the source runs out.
    //
    // This is a continuation, not the page-size heuristic it replaces: it asks
    // for what is still needed, from where it got to, and never guesses a size.
    while (kept.length < limit && !exhausted && reads < maxPasses) {
      reads++
      const rows = (await queryPage({ before: cursor, blocks, limit })) || []
      if (rows.length === 0) { exhausted = true; break }
      const participantIds = [...new Set(rows.flatMap(row => [
        row?.from, row?.from_id, ...(row?.recipients || []), row?.agent, row?.agent_id,
      ]).filter(Boolean))]
      temporal.observe(await getAgentsByIds(participantIds) || [])
      let examined = 0
      for (const row of rows) {
        examined++
        cursor = row.timestamp ?? cursor
        const participantLabels = temporal.participantLabels(row)
        if (await verdict(filter, row, { humanId, humanName, participantLabels })) {
          // Internal temporal state never crosses the subscription boundary.
          const { _filter_agents, ...publicRow } = row
          kept.push(publicRow)
        }
        if (kept.length >= limit) break
      }
      if (rows.length < limit && examined === rows.length) exhausted = true
    }

    // Unfilled and not exhausted: say so rather than implying the source ran
    // out. Reporting "no more" while matching rows remain is the failure that
    // loses someone's history.
    const truncated = reads >= maxPasses && kept.length < limit && !exhausted
    return {
      events: kept,
      hasMore: !exhausted,
      nextCursor: exhausted ? null : cursor,
      blocks: blocks.length,
      reads,
      truncated,
    }
  }

  // Per-filter delivery counts. The aggregate endpoint could not answer "is THIS
  // filter receiving anything", so a subscription that never matches — a dm:
  // filter subscribed with a null humanId, say — was indistinguishable from a
  // quiet one, and a real defect could not be established either way. That was
  // the limitation that left chat-lock's identity finding unprovable on
  // 2026-07-25 rather than confirmed or killed.
  //
  // Capped, because the count is bounded by distinct filters across all clients
  // and this is a diagnostics payload, not a metrics pipeline.
  const PER_FILTER_CAP = 50

  function perFilter() {
    const out = []
    for (const [key, entry] of byFilter) {
      if (out.length >= PER_FILTER_CAP) break
      out.push({
        filterKey: key,
        filter: entry.filter,
        subscriptions: entry.subs.size,
        deliveries: entry.deliveries || 0,
        lastDeliveryAt: entry.lastDeliveryAt || null,
        humanScoped: [...entry.subs.values()].some((sub) => !!sub.humanId),
      })
    }
    return out
  }

  function stats() {
    let subs = 0
    for (const entry of byFilter.values()) subs += entry.subs.size
    return {
      distinctFilters: byFilter.size,
      subscriptions: subs,
      connections: byConn.size,
      perFilter: perFilter(),
    }
  }

  return { subscribe, unsubscribe, dropConnection, match, verdict, history, stats }
}
