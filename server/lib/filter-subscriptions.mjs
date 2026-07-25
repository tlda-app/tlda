// Filter subscriptions: a chat is a filter, and the server answers it.
//
// A connection registers (subId, filter). Every event is evaluated ONCE per
// DISTINCT filter — not once per connection and not once per panel — and
// delivered to the subscriptions whose filter matched. Nineteen panels sharing
// four distinct filters cost four evaluations, not nineteen.
//
// Evaluation uses shared/filter-semantics.mjs, the same module the browser
// runs, against the server's authoritative roster. That is the whole point:
// the browser's roster is a live-biased page of a much larger fleet, so a
// filter naming an agent that had fallen out of it silently matched nothing.
// The server has every agent, so the partial-roster case is unreachable here.
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

import { matchesFleetFilter, resolveFleetFilter } from '../../shared/filter-semantics.mjs'

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

export function createFilterSubscriptions({ getAgents } = {}) {
  if (typeof getAgents !== 'function') {
    throw new Error('createFilterSubscriptions requires getAgents()')
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
    if (!entry) { entry = { filter, subs: new Map() }; byFilter.set(key, entry) }
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

  // The one place an evaluation context is built. It must carry the same keys
  // the browser passes (fleet-data.mjs: { agents, humanId, humanName }) — a
  // missing humanName makes the human answer to the label `user` instead of
  // their name, and breaks isHumanParticipant's name path. Two call sites with
  // different context shapes is the same one-file-two-behaviours divergence the
  // move to shared/ exists to end.
  function evalContext(agents, humanId, humanName) {
    return { agents, humanId, humanName }
  }

  /**
   * Does this event belong in this filter, for this subscriber?
   * Exposed so the live and history paths can be asserted to agree on real
   * traffic rather than merely being capable of agreeing.
   */
  function verdict(filter, event, { humanId = null, humanName = null } = {}) {
    return matchesFleetFilter(filter, event, evalContext(getAgents() || [], humanId, humanName))
  }

  /**
   * Evaluate one event against every distinct filter.
   * Returns [{ conn, subId }] for the subscriptions that matched.
   * `evaluations` on the returned array reports how many filters were run —
   * the number that must stay near the distinct-filter count, not the
   * subscription count.
   */
  function match(event) {
    const out = []
    let evaluations = 0
    for (const entry of byFilter.values()) {
      if (entry.subs.size === 0) continue
      evaluations++
      // Identity scopes `dm:`, and both halves matter: humanId for the id path
      // and humanName for the name path. Key on the pair.
      const humanKeys = new Set()
      for (const sub of entry.subs.values()) humanKeys.add(humanKeyOf(sub))
      if (humanKeys.size === 1) {
        const first = entry.subs.values().next().value
        if (verdict(entry.filter, event, first)) {
          for (const sub of entry.subs.values()) out.push({ conn: sub.conn, subId: sub.subId })
        }
        continue
      }
      const verdicts = new Map()
      for (const sub of entry.subs.values()) {
        const hk = humanKeyOf(sub)
        if (!verdicts.has(hk)) {
          if (verdicts.size > 0) evaluations++
          verdicts.set(hk, verdict(entry.filter, event, sub))
        }
        if (verdicts.get(hk)) out.push({ conn: sub.conn, subId: sub.subId })
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
   * defect that shipped in buildChatHistoryResponse. This asks for more until
   * the page fills or the source is exhausted, and reports the cursor from the
   * oldest row EXAMINED rather than the oldest row kept, so the next page
   * cannot skip the rows this one rejected.
   */
  async function history(filter, {
    humanId = null, humanName = null, before = null, limit = 50,
    queryPage, maxPasses = 10,
  } = {}) {
    if (typeof queryPage !== 'function') throw new Error('history requires queryPage()')
    const agentIds = [...resolveFleetFilter(filter, evalContext(getAgents() || [], humanId, humanName))]
    const kept = []
    let cursor = before
    let exhausted = false
    let passes = 0
    while (kept.length < limit && !exhausted && passes < maxPasses) {
      passes++
      const want = (limit - kept.length) * 2
      const rows = (await queryPage({ before: cursor, agentIds, limit: want })) || []
      if (rows.length === 0) { exhausted = true; break }
      if (rows.length < want) exhausted = true
      for (const row of rows) {
        cursor = row.timestamp ?? cursor
        if (verdict(filter, row, { humanId, humanName })) kept.push(row)
        if (kept.length >= limit) break
      }
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

  function stats() {
    let subs = 0
    for (const entry of byFilter.values()) subs += entry.subs.size
    return { distinctFilters: byFilter.size, subscriptions: subs, connections: byConn.size }
  }

  return { subscribe, unsubscribe, dropConnection, match, verdict, history, stats }
}
