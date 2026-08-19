/**
 * message-filter-sql.mjs — compile a desugared message-filter AST to SQL.
 *
 * WHY THIS EXISTS. `fleet-search` used to run the filter twice over, in two
 * different languages: SQL narrowed to the UNION of every agent id the filter
 * mentions, took the newest `limit` rows of that, and only then did JavaScript
 * apply the filter itself. So the page budget was spent on rows the filter was
 * about to throw away, and what came back was a short list — or nothing — with
 * no sign that anything had been cut.
 *
 * Measured on the live testing server, 2026-08-18: `search(query: "from:skip",
 * since: "1d", limit: 100)` returned 75 rows, all of them from one 28-minute
 * conversation, because the newest hundred rows *involving* Skip were his
 * exchange with one agent. Everything he said to every other agent that day was
 * absent from an answer that looked complete. The same query bounded to one
 * earlier hour returned 205 rows. Nothing was missing from the database; the
 * limit had been spent before the filter ran.
 *
 * That is why this is a compiler rather than a bigger candidate window: a
 * window is a guess, and the failure it produces is the one Skip named as the
 * most expensive — "silently empty is the one option that costs someone a day."
 * With the filter in the WHERE clause, `LIMIT n` means n matching rows.
 *
 * The JS evaluator (`matchesMessageNode` in unified-server) stays as the
 * authority and still runs over what comes back. These two must agree, and
 * `message-filter-sql.test.mjs` is what holds them together: it evaluates both
 * against the same rows. Compilation is all-or-nothing — an unsupported node
 * returns null for the whole filter and the caller falls back to the old
 * prefilter — so a future node type degrades to slow rather than to wrong.
 *
 * NULL columns follow the evaluator, which asks set membership of a possibly
 * missing value: `agent_id IN (…)` is NULL when `agent_id` is, so every
 * negation wraps in COALESCE(…, 0) to get JS's `!has(null)` === true rather
 * than SQL's NULL.
 */

/**
 * Every agent-expression node the filter mentions, in walk order. The caller
 * resolves each to a set of fleet ids (async, against the store) and hands the
 * lookup back to `compileMessageFilterSql`.
 */
export function agentNodesInMessageFilter(node, out = []) {
  if (!node) return out
  switch (node.t) {
    case 'from':
    case 'to':
      collectAgentNodes(node.x, out)
      return out
    case 'lit':
    case 'me':
      collectAgentNodes(node, out)
      return out
    case 'and':
    case 'or':
      agentNodesInMessageFilter(node.l, out)
      agentNodesInMessageFilter(node.r, out)
      return out
    case 'not':
      return agentNodesInMessageFilter(node.x, out)
    default:
      return out
  }
}

function collectAgentNodes(node, out) {
  if (!node) return
  switch (node.t) {
    case 'lit':
    case 'me':
      out.push(node)
      return
    case 'and':
    case 'or':
      collectAgentNodes(node.l, out)
      collectAgentNodes(node.r, out)
      return
    case 'not':
      collectAgentNodes(node.x, out)
      return
    default:
      out.push(node) // unsupported; compilation will refuse on it
  }
}

const TRUE = { sql: '1', params: [] }
const FALSE = { sql: '0', params: [] }

/**
 * Compile `node` (a DESUGARED message filter — `involving` and `between`
 * already expanded) into predicates over the events table and over the session
 * table. Returns null if any node cannot be compiled, in which case the caller
 * must not narrow at all.
 *
 * `idsFor(agentNode)` returns the fleet ids that agent expression names.
 * `events`/`sessions` name the table aliases and are the only thing that
 * differs between the two predicates: an events row has a sender and a
 * recipient set, a session row has neither, so `from:`/`to:` are simply false
 * against one — which is not the same as excluding session rows, because
 * `!from:X` is true of them.
 */
export function compileMessageFilterSql(node, { idsFor, eventsAlias = 'e', sessionsAlias = 's' } = {}) {
  if (!node) return { events: TRUE, sessions: TRUE }

  const agentExpr = (n, col) => {
    if (!n) return null
    switch (n.t) {
      case 'lit':
      case 'me': {
        const ids = idsFor(n) || []
        if (!ids.length) return FALSE
        return { sql: `${col} IN (${ids.map(() => '?').join(',')})`, params: [...ids] }
      }
      case 'and':
      case 'or': {
        const l = agentExpr(n.l, col)
        const r = agentExpr(n.r, col)
        if (!l || !r) return null
        return { sql: `(${l.sql} ${n.t === 'and' ? 'AND' : 'OR'} ${r.sql})`, params: [...l.params, ...r.params] }
      }
      case 'not': {
        const x = agentExpr(n.x, col)
        if (!x) return null
        return { sql: `NOT COALESCE(${x.sql}, 0)`, params: x.params }
      }
      default:
        return null
    }
  }

  const messageExpr = (n, ctx) => {
    if (!n) return TRUE
    switch (n.t) {
      case 'from':
        return ctx.from ? agentExpr(n.x, ctx.from) : FALSE
      case 'to':
        return ctx.recipient ? recipientExists(n.x, ctx, agentExpr) : FALSE
      case 'lit':
      case 'me': {
        // A bare token asks whether the message involves that agent at all:
        // sender, any recipient, or the row's owning agent.
        const parts = []
        if (ctx.from) parts.push(agentExpr(n, ctx.from))
        if (ctx.recipient) parts.push(recipientExists(n, ctx, agentExpr))
        if (ctx.owner) parts.push(agentExpr(n, ctx.owner))
        if (parts.some(p => !p)) return null
        if (!parts.length) return FALSE
        return {
          sql: `(${parts.map(p => p.sql).join(' OR ')})`,
          params: parts.flatMap(p => p.params),
        }
      }
      // A row with no timestamp is not excluded by a time bound, the same way
      // the evaluator reads it.
      case 'since':
        return { sql: `(${ctx.timestamp} IS NULL OR ${ctx.timestamp} >= ?)`, params: [n.v] }
      case 'before':
        return { sql: `(${ctx.timestamp} IS NULL OR ${ctx.timestamp} < ?)`, params: [n.v] }
      case 'type':
        return { sql: `(${ctx.type.map(c => `${c} = ?`).join(' OR ')})`, params: ctx.type.map(() => n.v) }
      case 'and':
      case 'or': {
        const l = messageExpr(n.l, ctx)
        const r = messageExpr(n.r, ctx)
        if (!l || !r) return null
        return { sql: `(${l.sql} ${n.t === 'and' ? 'AND' : 'OR'} ${r.sql})`, params: [...l.params, ...r.params] }
      }
      case 'not': {
        const x = messageExpr(n.x, ctx)
        if (!x) return null
        return { sql: `NOT COALESCE(${x.sql}, 0)`, params: x.params }
      }
      default:
        return null
    }
  }

  const events = messageExpr(node, {
    from: `${eventsAlias}.from_id`,
    recipient: { eventId: `${eventsAlias}.id`, col: 'agent_id' },
    owner: `${eventsAlias}.agent_id`,
    timestamp: `${eventsAlias}.timestamp`,
    type: [`${eventsAlias}.type`],
  })
  const sessions = messageExpr(node, {
    // A session row has no sender, which the evaluator reads as a sender of
    // null — so `from:X` is false against it and `from:(!X)` is TRUE, because
    // null is not X. Writing the column as the literal NULL keeps SQL's
    // three-valued answer identical to the evaluator's rather than merely
    // sensible. Its recipient set is empty, and `some` over an empty set is
    // false however it is negated, so `to:` is flatly false.
    from: 'NULL',
    recipient: null,
    owner: `${sessionsAlias}.agent_id`,
    timestamp: `${sessionsAlias}.timestamp`,
    type: [`${sessionsAlias}.role`],
  })
  if (!events || !sessions) return null
  return { events, sessions }
}

/**
 * The same compiler, packaged the way `searchAll` needs it: the events table is
 * aliased `e` in one query and left bare as `events` in the tuned per-agent and
 * pair reads, so the predicate is built per call site rather than once. Returns
 * null if the filter cannot be compiled at all.
 */
export function messageFilterSqlCompiler(node, idsFor) {
  if (compileMessageFilterSql(node, { idsFor }) === null) return null
  const cache = new Map()
  const at = (alias, side) => {
    const key = `${side}:${alias}`
    if (!cache.has(key)) {
      const compiled = compileMessageFilterSql(node, {
        idsFor,
        eventsAlias: alias,
        sessionsAlias: alias,
      })
      cache.set(key, compiled?.[side] || null)
    }
    return cache.get(key)
  }
  return {
    events: (alias) => at(alias, 'events'),
    sessions: (alias) => at(alias, 'sessions'),
  }
}

// `to:` is membership in the event's recipient set, which is rows in
// `recipients` keyed (event_id, agent_id) — a primary-key probe per candidate
// row, the same shape the existing agent prefilter already uses.
function recipientExists(agentNode, ctx, agentExpr) {
  const inner = agentExpr(agentNode, `rc.${ctx.recipient.col}`)
  if (!inner) return null
  return {
    sql: `EXISTS (SELECT 1 FROM recipients rc WHERE rc.event_id = ${ctx.recipient.eventId} AND ${inner.sql})`,
    params: inner.params,
  }
}
