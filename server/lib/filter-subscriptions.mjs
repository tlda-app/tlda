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

import { matchesFleetFilter, fleetFilterLabels } from '../../shared/filter-semantics.mjs'
import { labelsForAgent, PSEUDO_LABELS } from '../../shared/fleet-labels.mjs'

const REALTIME_LABELS = new Set(PSEUDO_LABELS)

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
      const expanded = new Set(labelsForAgent(agent))
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
      event?.from, event?.from_id, event?.to, event?.to_id,
      event?.agent, event?.agent_id,
    ].filter(Boolean))]
    const out = Object.create(null)
    for (const id of ids) {
      const labels = new Set([id])
      for (const label of this.labels) {
        if (live || REALTIME_LABELS.has(label)) {
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

  function subscribe(conn, subId, filter, { humanId = null, humanName = null } = {}) {
    if (!conn || !subId) return null
    const key = filterKey(filter)
    let entry = byFilter.get(key)
    if (!entry) {
      entry = {
        filter,
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
          event?.from, event?.from_id, event?.to, event?.to_id,
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
      if (eventAgents === null) {
        eventAgents = Array.isArray(event?._filter_agents)
          ? event._filter_agents
          : await getAgentsByIds([
            event?.from, event?.from_id, event?.to, event?.to_id,
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
   * OVER-FETCHES. The exact predicate runs after the query's LIMIT, so a naive
   * single pass returns a short page with a cursor that looks correct — the
   * defect that shipped in the old direct-history path. This asks for more until
   * the page fills or the source is exhausted, and reports the cursor from the
   * oldest row EXAMINED rather than the oldest row kept, so the next page
   * cannot skip the rows this one rejected.
   */
  async function history(filter, {
    humanId = null, humanName = null, before = null, limit = 50,
    queryPage, maxPasses = 25,
  } = {}) {
    if (typeof queryPage !== 'function') throw new Error('history requires queryPage()')
    const entry = byFilter.get(filterKey(filter))
    const temporal = entry?.temporal || new TemporalMembership(filter)
    const kept = []
    let cursor = before
    let exhausted = false
    let passes = 0
    while (kept.length < limit && !exhausted && passes < maxPasses) {
      passes++
      // Count is post-filter, so the time range cannot be known in advance.
      // Walk indexed time chunks, extend this filter instance's temporal join
      // table to the chunk, then keep only joined matches.
      const want = Math.min(1000, Math.max(
        200,
        (limit - kept.length) * 4,
        200 * (2 ** Math.min(passes - 1, 3)),
      ))
      const rows = (await queryPage({ before: cursor, agentIds: [], limit: want })) || []
      if (rows.length === 0) { exhausted = true; break }
      const sourceExhausted = rows.length < want
      const participantIds = [...new Set(rows.flatMap(row => [
        row?.from, row?.from_id, row?.to, row?.to_id, row?.agent, row?.agent_id,
      ]).filter(Boolean))]
      temporal.observe(await getAgentsByIds(participantIds) || [])
      const oldest = rows[rows.length - 1]?.timestamp || cursor
      const upper = cursor || new Date().toISOString()
      const spans = await loadMembershipSpans([...temporal.labels], {
        from: oldest,
        to: upper,
      })
      temporal.extend(spans, oldest, upper)
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
      if (sourceExhausted && examined === rows.length) exhausted = true
    }
    // Ran out of passes with the page unfilled: say so rather than implying the
    // source is exhausted. A caller that ignores this is asking for the short
    // page this function exists to prevent.
    const truncated = passes >= maxPasses && kept.length < limit && !exhausted
    return {
      events: kept,
      hasMore: !exhausted,
      nextCursor: exhausted ? null : cursor,
      passes,
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
