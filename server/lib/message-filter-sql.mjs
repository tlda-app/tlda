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
 * prefilter. That fallback is exact about the rows it returns and silent
 * about the rows it never reads: the page is spent pre-filter and the
 * post-filter pass discards without refilling, so a declined filter comes
 * back short with no sign of what was cut — worst in history mode, which is
 * what a filter-only `model:` query is. Neither call site compensates:
 * `fleet-store.mjs:7642` (events) and `:7812` (sessions) add the predicate
 * when compilation succeeds and widen nothing when it does not.
 *
 * NULL columns follow the evaluator, which asks set membership of a possibly
 * missing value: `agent_id IN (…)` is NULL when `agent_id` is, so every
 * negation wraps in COALESCE(…, 0) to get JS's `!has(null)` === true rather
 * than SQL's NULL.
 */

/**
 * Every agent-expression node the filter mentions, in walk order. The caller
 * resolves each to the SPANS it names (async, against the store) and hands the
 * lookup back to `compileMessageFilterSql`.
 *
 * Spans rather than ids because a name binds at the point of use. `from:chief`
 * over a week names whoever held `chief` when each message was sent, so the
 * predicate it compiles to is `from_id = ? AND timestamp >= ? AND timestamp <
 * ?` — one disjunct per interval — and never a flat `from_id IN (…)`, which
 * would answer with every holder's traffic blended together.
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
 * The SQL half of a lexical name. `col` is an agent-id column, `ts` the row's
 * timestamp expression.
 *
 * An unconditional span — both ends null, meaning an id, a lineage seat, or a
 * label — tests the id alone. A bounded span adds the interval over which that
 * id held the name, so a row is matched by the holder at ITS OWN timestamp and
 * not by every holder there has ever been.
 *
 * Exported because `searchAll`'s agent prefilter needs exactly this predicate
 * on the path that carries no filter expression. One implementation, so the
 * two cannot drift into answering differently.
 */
export function agentSpanPredicate(spans, col, ts) {
  const unconditional = [...new Set(
    (spans || []).filter(s => s?.from_ts == null && s?.to_ts == null).map(s => s.id),
  )]
  const parts = []
  const params = []
  if (unconditional.length) {
    parts.push(`${col} IN (${unconditional.map(() => '?').join(',')})`)
    params.push(...unconditional)
  }
  const covered = new Set(unconditional)
  const seen = new Set()
  for (const span of spans || []) {
    if (!span?.id) continue
    if (span.from_ts == null && span.to_ts == null) continue
    if (covered.has(span.id)) continue
    const key = `${span.id}\0${span.from_ts || ''}\0${span.to_ts || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    const conds = [`${col} = ?`]
    params.push(span.id)
    if (span.from_ts != null) { conds.push(`${ts} >= ?`); params.push(span.from_ts) }
    if (span.to_ts != null) { conds.push(`${ts} < ?`); params.push(span.to_ts) }
    parts.push(`(${conds.join(' AND ')})`)
  }
  if (!parts.length) return null
  return { sql: parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`, params }
}

/**
 * Compile `node` (a DESUGARED message filter — `involving` and `between`
 * already expanded) into predicates over the events table and over the session
 * table. Returns null if any node cannot be compiled, in which case the caller
 * must not narrow at all.
 *
 * `spansFor(agentNode)` returns the spans that agent expression names, as
 * `{ id, from_ts, to_ts }`. Both ends null means unconditional — an id, a
 * lineage seat, a label — and compiles to a bare id test.
 * `events`/`sessions` name the table aliases and are the only thing that
 * differs between the two predicates: an events row has a sender and a
 * recipient set, a session row has neither, so `from:`/`to:` are simply false
 * against one — which is not the same as excluding session rows, because
 * `!from:X` is true of them.
 */
export function compileMessageFilterSql(node, { spansFor, eventsAlias = 'e', sessionsAlias = 's' } = {}) {
  if (!node) return { events: TRUE, sessions: TRUE }

  // `ts` is the row's timestamp expression, and it is what makes the name
  // lexical: the unconditional spans collapse into one id test, and each
  // bounded span becomes that id AND the interval it held the name over. A
  // NULL timestamp fails every bounded comparison, which is the same answer
  // `agentSpanCovers` gives an undated row.
  const agentExpr = (n, col, ts) => {
    if (!n) return null
    switch (n.t) {
      case 'lit':
      case 'me': {
        return agentSpanPredicate(spansFor(n) || [], col, ts) || FALSE
      }
      case 'and':
      case 'or': {
        const l = agentExpr(n.l, col, ts)
        const r = agentExpr(n.r, col, ts)
        if (!l || !r) return null
        return { sql: `(${l.sql} ${n.t === 'and' ? 'AND' : 'OR'} ${r.sql})`, params: [...l.params, ...r.params] }
      }
      case 'not': {
        const x = agentExpr(n.x, col, ts)
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
        return ctx.from ? agentExpr(n.x, ctx.from, ctx.timestamp) : FALSE
      case 'to':
        return ctx.recipient ? recipientExists(n.x, ctx, agentExpr) : FALSE
      case 'lit':
      case 'me': {
        // A bare token asks whether the message involves that agent at all:
        // sender, any recipient, or the row's owning agent.
        const parts = []
        if (ctx.from) parts.push(agentExpr(n, ctx.from, ctx.timestamp))
        if (ctx.recipient) parts.push(recipientExists(n, ctx, agentExpr))
        if (ctx.owner) parts.push(agentExpr(n, ctx.owner, ctx.timestamp))
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
      // `ctx.id` is null for the sessions predicate: a session row's id is not
      // the id anything hands out, so `id:` is flatly false against one — the
      // same way `to:` is, and for the same reason.
      case 'id':
        return ctx.id ? { sql: `${ctx.id} = ?`, params: [n.v] } : FALSE
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
    id: `${eventsAlias}.id`,
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
    id: null,
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
export function messageFilterSqlCompiler(node, spansFor) {
  if (compileMessageFilterSql(node, { spansFor }) === null) return null
  const cache = new Map()
  const at = (alias, side) => {
    const key = `${side}:${alias}`
    if (!cache.has(key)) {
      const compiled = compileMessageFilterSql(node, {
        spansFor,
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
  // `ctx.timestamp` names the OUTER row's column, correlated into the subquery:
  // the instant that decides which agent a name pointed at is the message's,
  // not anything the recipients table carries.
  const inner = agentExpr(agentNode, `rc.${ctx.recipient.col}`, ctx.timestamp)
  if (!inner) return null
  return {
    sql: `EXISTS (SELECT 1 FROM recipients rc WHERE rc.event_id = ${ctx.recipient.eventId} AND ${inner.sql})`,
    params: inner.params,
  }
}
