/**
 * fleet-labels.mjs — single source of truth for "what labels does an agent
 * answer to" and "does a filter expression match a label set".
 *
 * Before this module the label-expansion logic was hand-copied in six places
 * (client display `agentMatchesLabel`, client history `resolveFilter`, client
 * send `resolveToFleetId(s)`, the server chat router, the server wiretap
 * matcher, and bots). The copies had already drifted — e.g. `resolveFilter`
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
 * Filter expressions — a tiny boolean language over labels.
 *
 * A filter is a STRING like `fleet:skip`, `awake & reviewers`, or
 * `mathy & !goose`. The grammar:
 *
 *   expr  := or
 *   or    := and ( '|' and )*
 *   and   := not ( '&' not )*
 *   not   := '!' not | atom
 *   atom  := '(' or ')' | TOKEN
 *   TOKEN := a maximal run of characters that are not whitespace or & | ! ( )
 *
 * A bare TOKEN is a label/name/id, tested against the agent's label set
 * (`labelsForAgent`). `&` is AND, `|` is OR, `!` is NOT, parens group; `&`
 * binds tighter than `|`. An empty/whitespace string parses to `null`, which
 * matches everything (the old empty-DNF behaviour).
 *
 * The string is DATA: `parseFilter` turns it into a small AST and `evalExpr`
 * walks that AST with `labels.has(token)`. There is no `eval()` / `Function()`
 * — a token can only ever be membership-tested, so there is no code-execution
 * or injection surface.
 */

function tokenizeFilter(str) {
  const toks = []
  let i = 0
  const n = str.length
  while (i < n) {
    const c = str[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue }
    if (c === '&' || c === '|' || c === '!' || c === '(' || c === ')') {
      toks.push({ k: 'op', v: c }); i++; continue
    }
    let j = i
    while (j < n) {
      const d = str[j]
      if (d === ' ' || d === '\t' || d === '\n' || d === '\r' ||
          d === '&' || d === '|' || d === '!' || d === '(' || d === ')') break
      j++
    }
    toks.push({ k: 'lit', v: str.slice(i, j) })
    i = j
  }
  return toks
}

/**
 * Parse a filter string into an AST (or `null` for an empty/whitespace filter,
 * meaning "match everything"). Throws on malformed input — there is no silent
 * fallback to match-all, so a typo'd filter fails loud rather than fanning out.
 */
export function parseFilter(input) {
  if (input == null) return null
  if (typeof input !== 'string') {
    throw new Error(`filter must be a string expression, got ${Array.isArray(input) ? 'array' : typeof input}`)
  }
  const toks = tokenizeFilter(input)
  if (toks.length === 0) return null
  let p = 0
  const peek = () => toks[p]
  const eat = (v) => {
    const t = toks[p]
    if (!t || (v && !(t.k === 'op' && t.v === v))) {
      throw new Error(`filter parse error: expected ${v || 'token'} at position ${p} in "${input}"`)
    }
    p++; return t
  }
  function parseOr() {
    let node = parseAnd()
    while (peek() && peek().k === 'op' && peek().v === '|') { eat('|'); node = { t: 'or', l: node, r: parseAnd() } }
    return node
  }
  function parseAnd() {
    let node = parseNot()
    while (peek() && peek().k === 'op' && peek().v === '&') { eat('&'); node = { t: 'and', l: node, r: parseNot() } }
    return node
  }
  function parseNot() {
    if (peek() && peek().k === 'op' && peek().v === '!') { eat('!'); return { t: 'not', x: parseNot() } }
    return parseAtom()
  }
  function parseAtom() {
    const t = peek()
    if (!t) throw new Error(`filter parse error: unexpected end of "${input}"`)
    if (t.k === 'op' && t.v === '(') { eat('('); const e = parseOr(); eat(')'); return e }
    if (t.k === 'lit') { p++; return { t: 'lit', v: t.v } }
    throw new Error(`filter parse error: unexpected "${t.v}" in "${input}"`)
  }
  const ast = parseOr()
  if (p !== toks.length) throw new Error(`filter parse error: trailing "${toks[p].v}" in "${input}"`)
  return ast
}

/**
 * Evaluate a parsed filter AST (from `parseFilter`) against an agent's label
 * set. `labels` may be an array or a Set. A `null` AST matches everything.
 */
export function evalExpr(ast, labels) {
  if (!ast) return true
  const has = labels instanceof Set
    ? (x) => labels.has(x)
    : (x) => (Array.isArray(labels) ? labels.includes(x) : false)
  const ev = (n) => {
    switch (n.t) {
      case 'lit': return has(n.v)
      case 'not': return !ev(n.x)
      case 'and': return ev(n.l) && ev(n.r)
      case 'or': return ev(n.l) || ev(n.r)
      default: return false
    }
  }
  return ev(ast)
}

/**
 * Convenience: parse `filter` (string or AST) and evaluate against `labels` in
 * one call. Prefer `parseFilter` once + `evalExpr` per-agent when looping over
 * many agents.
 */
export function matchFilter(filter, labels) {
  return evalExpr(parseFilter(filter), labels)
}

/**
 * Evaluate a DNF filter (array of AND-clauses) against a precomputed label set.
 * A term is either a `[role, label]` tuple or a bare string label; the role is
 * ignored here (directional from/to selection is the caller's responsibility —
 * see `matchesFilter`). An empty/absent filter matches everything.
 *
 * Distinct from `parseFilter`/`evalExpr` (the chat-send / fleet_table label
 * EXPRESSION): this is the role-aware DNF used by the chat shape's display
 * filter and history resolution (`matchesFilter` / `resolveFilter`), which
 * carries `[role, label]` direction the expression grammar doesn't model.
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

function dnfPath(clauseIndex, termIndex) {
  if (termIndex == null) return `filter[${clauseIndex}]`
  return `filter[${clauseIndex}][${termIndex}]`
}

/**
 * Validate the role-aware DNF shape used by wiretap and fleet-chat display
 * filters. Returns the original filter for easy inline use; throws with a path
 * to the malformed term so callers can surface a useful "bad filter" message.
 */
export function validateDnfFilter(filter, { directional = false } = {}) {
  if (!Array.isArray(filter)) throw new Error('filter must be a DNF array')
  for (let i = 0; i < filter.length; i++) {
    const clause = filter[i]
    if (!Array.isArray(clause)) throw new Error(`${dnfPath(i)} must be an array clause`)
    for (let j = 0; j < clause.length; j++) {
      const term = clause[j]
      if (directional) {
        if (!Array.isArray(term) || term.length !== 2) {
          throw new Error(`${dnfPath(i, j)} must be [role, label]`)
        }
        const [role, label] = term
        if (role !== 'from' && role !== 'to') {
          throw new Error(`${dnfPath(i, j)} role must be "from" or "to"`)
        }
        if (typeof label !== 'string' || !label) {
          throw new Error(`${dnfPath(i, j)} label must be a non-empty string`)
        }
      } else if (Array.isArray(term)) {
        if (term.length !== 2 || typeof term[1] !== 'string' || !term[1]) {
          throw new Error(`${dnfPath(i, j)} tuple label must be a non-empty string`)
        }
      } else if (typeof term !== 'string' || !term) {
        throw new Error(`${dnfPath(i, j)} must be a non-empty label string`)
      }
    }
  }
  return filter
}

/**
 * Evaluate directional DNF against sender/recipient labels.
 * Empty DNF matches everything, matching evalDnf's legacy behavior.
 */
export function evalDirectionalDnf(filter, { fromLabels = [], toLabels = [] } = {}) {
  const dnf = validateDnfFilter(filter || [], { directional: true })
  if (dnf.length === 0) return true
  const from = new Set(fromLabels)
  const to = new Set(toLabels)
  return dnf.some(clause =>
    clause.every(([role, label]) => role === 'from' ? from.has(label) : to.has(label)),
  )
}
