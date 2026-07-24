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
 * `runtime_status.status` (awake|hibernating|human|human-away|dead), parsed
 * `labels`, `friendly_name`, `id`, and `lineage_name`. The client
 * receives the same shape over /api/state and the WS push.
 */

/**
 * The reserved routing labels derived from an agent's status. A friendly_name
 * or explicit label may not collide with these (see fleet-store name checks).
 */
export const PSEUDO_LABELS = Object.freeze(['awake', 'hibernating', 'unavailable', 'human', 'human-away'])

/** Pseudo-labels implied by an agent's status. */
export function statusLabels(status) {
  switch (status) {
    case 'awake': return ['awake']
    case 'hibernating': return ['hibernating']
    case 'unavailable': return ['unavailable']
    case 'human': return ['human']
    case 'human-away': return ['human', 'human-away']
    default: return []
  }
}

/**
 * The full set of labels a (hydrated) agent answers to, for chat routing,
 * filtering, and history resolution.
 *
 * Includes: explicit labels[], status pseudo-labels, friendly_name, id.
 * Each agent answers ONLY to its own full name — the base name does NOT fan out
 * to the whole lineage. Lineage is a name-rotation convention, a search gloss,
 * and a graphical overlay; it is not a chat-routing label.
 */
export function labelsForAgent(agent) {
  if (!agent) return []
  const category = fleetRosterCategory(agent)
  const out = [
    ...(agent.labels || []),
    ...statusLabels(runtimeStatusName(agent)),
    category === 'awake' ? 'awake' : null,
    category === 'hibernating' ? 'hibernating' : null,
    agent.friendly_name,
    agent.id,
  ]
  return [...new Set(out.filter(Boolean))]
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

import { fleetRosterCategory, runtimeStatusName } from './fleet-runtime-status.mjs'
import { desugarMessageFilter, parseUnifiedFilter } from './unified-filter-grammar.mjs'

/**
 * Parse a filter string into an AST (or `null` for an empty/whitespace filter,
 * meaning "match everything"). Throws on malformed input — there is no silent
 * fallback to match-all, so a typo'd filter fails loud rather than fanning out.
 */
export function parseFilter(input) {
  return parseUnifiedFilter(input, { sort: 'message' })
}

export function parseMessageFilter(input) {
  return desugarMessageFilter(parseUnifiedFilter(input, { sort: 'message' }))
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
      case 'me': return has('me')
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
 * Evaluate a parsed filter AST (from `parseFilter`) in a DIRECTIONAL context —
 * a message that has sender labels (`fromLabels`) and recipient labels
 * (`toLabels`). This is what wiretap uses, so wiretap, chat-send, and
 * fleet_table all share ONE parser (`parseFilter`) and differ only in how a
 * leaf token is tested.
 *
 * Leaf token interpretation:
 *   - `to:LABEL`   → matches iff the RECIPIENT carries LABEL
 *   - `from:LABEL` → matches iff the SENDER carries LABEL
 *   - bare `LABEL` → matches iff EITHER side carries LABEL (message involves it)
 *
 * `&`/`|`/`!`/parens compose exactly as in `evalExpr`. A `null` AST (empty
 * filter) matches everything. `fromLabels`/`toLabels` may be arrays or Sets.
 *
 * The role prefixes `to:`/`from:` replace the old `[role, label]` DNF tuples:
 * `to:skip & from:math` is the string form of `[[["to","skip"],["from","math"]]]`.
 */
// `subscriberLabels` is read by exactly one construct below — the `my_labels`
// token. Every other filter ignores it entirely. Callers that would have to do
// real work to produce it (resolveWiretaps loads an entire agent record per
// subscription, per message) ask this first and skip that work when the answer
// is no. Kept beside evalExprDirectional so the two cannot drift: if a new node
// type starts reading `subscriber`, it must be added here too.
export function astReadsSubscriberLabels(ast) {
  if (!ast) return false
  switch (ast.t) {
    case 'lit': return ast.v === 'my_labels'
    case 'my_labels': return true
    case 'me': return false
    case 'not': return astReadsSubscriberLabels(ast.x)
    case 'from':
    case 'to':
    case 'involving': return astReadsSubscriberLabels(ast.x)
    case 'and':
    case 'or': return astReadsSubscriberLabels(ast.l) || astReadsSubscriberLabels(ast.r)
    default: return false
  }
}

export function evalExprDirectional(ast, { fromLabels = [], toLabels = [], subscriberLabels = [] } = {}) {
  if (!ast) return true
  const from = fromLabels instanceof Set ? fromLabels : new Set(fromLabels)
  const to = toLabels instanceof Set ? toLabels : new Set(toLabels)
  const subscriber = subscriberLabels instanceof Set ? subscriberLabels : new Set(subscriberLabels)
  const testLeaf = (tok) => {
    if (tok.startsWith('to:')) return to.has(tok.slice(3))
    if (tok.startsWith('from:')) return from.has(tok.slice(5))
    return from.has(tok) || to.has(tok)
  }
  const agentExpr = (n, labels) => {
    switch (n.t) {
      case 'lit': return n.v === 'my_labels'
        ? (subscriber.size > 0 && [...subscriber].some(label => labels.has(label)))
        : labels.has(n.v)
      case 'me': return labels.has('me')
      case 'my_labels': return subscriber.size > 0 && [...subscriber].some(label => labels.has(label))
      case 'not': return !agentExpr(n.x, labels)
      case 'and': return agentExpr(n.l, labels) && agentExpr(n.r, labels)
      case 'or': return agentExpr(n.l, labels) || agentExpr(n.r, labels)
      default: return false
    }
  }
  const ev = (n) => {
    switch (n.t) {
      case 'lit': return testLeaf(n.v)
      case 'from': return agentExpr(n.x, from)
      case 'to': return agentExpr(n.x, to)
      case 'involving': return agentExpr(n.x, from) || agentExpr(n.x, to)
      case 'not': return !ev(n.x)
      case 'and': return ev(n.l) && ev(n.r)
      case 'or': return ev(n.l) || ev(n.r)
      default: return false
    }
  }
  return ev(ast)
}
