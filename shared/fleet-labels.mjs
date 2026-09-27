/**
 * fleet-labels.mjs — single source of truth for "what labels does an agent
 * answer to" and "does a filter expression match a label set".
 *
 * Before this module the label-expansion logic was hand-copied in six places
 * (client display `agentMatchesLabel`, client history `resolveFilter`, client
 * send `resolveToFleetId(s)`, the server chat router, the server wiretap
 * matcher, and bots). The copies had already drifted — e.g. `resolveFilter`
 * dropped the human runtime/identity pseudo-labels, so a chat scoped to `human`
 * showed live messages but returned empty backfilled history (the same class
 * of bug as the lineage-agent scrollback issue). One resolver kills that.
 *
 * Imported by both the server (.mjs, Node) and the bundled client
 * (src/fleet/fleet-data.mjs, src/shapes/FleetChatShape.tsx via Vite) — keep it
 * dependency-free.
 *
 * Inputs are *hydrated* agent objects (fleet-store `_hydrateAgent`): they carry
 * `runtime_status` as a validated human→here|away or
 * ai→awake|hibernating|dead pair, parsed
 * `labels`, `friendly_name`, `id`, and `lineage_name`. The client
 * receives the same shape over /api/state and the WS push.
 */

/**
 * The reserved routing labels derived from an agent's status. A friendly_name
 * or explicit label may not collide with these (see fleet-store name checks).
 */
export const PSEUDO_LABELS = Object.freeze(['here', 'away', 'awake', 'hibernating', 'dead', 'human'])

/** Pseudo-labels implied by an agent's status. */
export function statusLabels(runtime) {
  return runtime?.status ? [runtime.status] : []
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
  const runtime = runtimeStatusForAgent(agent)
  const out = [
    ...(agent.labels || []),
    ...statusLabels(runtime),
    runtime.kind === RUNTIME_KIND.HUMAN ? 'human' : null,
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

import { RUNTIME_KIND, runtimeStatusForAgent } from './fleet-runtime-status.mjs'
import { desugarMessageFilter, parseUnifiedFilter } from './unified-filter-grammar.mjs'

/**
 * Parse a filter string into an AST (or `null` for an empty/whitespace filter,
 * meaning "match everything"). Throws on malformed input — there is no silent
 * fallback to match-all, so a typo'd filter fails loud rather than fanning out.
 */
export function parseFilter(input) {
  return parseUnifiedFilter(input, { sort: 'message' })
}

// Undo HTML escaping on a filter expression before it reaches the grammar.
//
// Only the four entities an escaper produces, and only in this direction: a
// filter is never HTML, so there is nothing here to re-escape and no way for a
// legitimate expression to be altered. `&amp;` goes last so `&amp;lt;` decodes
// to `&lt;` rather than to `<` — a doubly-escaped string should come back one
// layer, not collapse.
export function decodeFilterEntities(s) {
  if (!s.includes('&')) return s
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
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
      // `model:` parses to its own node rather than to the `model:X` literal
      // it used to be, so the membership test is spelled out: a label set
      // carrying `model:<present value>` (see fleetTableLabelsForAgent)
      // matches exactly that value, and one without it matches nothing.
      case 'model': return has(`model:${n.v}`)
      case 'not': return !ev(n.x)
      case 'and': return ev(n.l) && ev(n.r)
      case 'or': return ev(n.l) || ev(n.r)
      default: return false
    }
  }
  return ev(ast)
}

/**
 * Walk a parsed filter AST as a SET expression, combining leaf results with set
 * operations the caller supplies.
 *
 * Same principle as `evalExprDirectional` below — one parser, one algebra, and
 * the callers differ only in how a leaf is interpreted. The difference here is
 * that a leaf resolves to a SET of agents rather than a boolean, and the two
 * callers disagree about what a set is and what a name means:
 *
 *   - chat recipients (`FleetStore.resolveChatRecipients`) — a `Map<id, agent>`
 *     of who is in the set NOW;
 *   - search/thread (`resolveAgentNode` in unified-server) — an array of
 *     `{id, from_ts, to_ts}` spans covering every id a name EVER pointed at.
 *
 * Those two questions must stay distinct — see the comment on
 * `resolveAgentSpans`, where collapsing them made a read of a previous seat
 * holder's whole day come back empty. Only the traversal is shared, and it was
 * previously written out twice over identical node shapes.
 *
 * The walk is pure and synchronous: leaves arrive already resolved. That is
 * deliberate rather than incidental. Leaf resolution is the whole cost here —
 * a SQL query or an IPC round-trip per literal — so keeping it outside the
 * algebra is what allows it to be batched, parallelised or cached without this
 * function changing at all.
 *
 * `negate` receives the `not` NODE, not its evaluated child, so that neither
 * caller starts evaluating a subtree it currently skips. Both decline to, for
 * different reasons: chat does not support negation, and search enforces it in
 * its post-filter and must not broaden its SQL prefilter to the whole fleet.
 * `other` is the escape hatch for node types only one caller knows (`me`).
 */
export function walkAgentSetExpr(ast, { leaf, intersect, union, negate, other, empty = null } = {}) {
  const walk = (node) => {
    if (!node) return empty
    switch (node.t) {
      case 'lit': return leaf(node)
      case 'and': return intersect(walk(node.l), walk(node.r))
      case 'or': return union(walk(node.l), walk(node.r))
      case 'not': return negate ? negate(node) : empty
      default: return other ? other(node, walk) : empty
    }
  }
  return walk(ast)
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
 * roster all share ONE parser (`parseFilter`) and differ only in how a
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
/**
 * A stable string identifying a parsed expression, for use as a cache key.
 *
 * Recurses explicitly and sorts keys at every level. It does NOT use
 * `JSON.stringify(ast, keysArray)`: that argument is a property ALLOWLIST
 * applied at every depth, so the top node's key names are the only ones any
 * nested node may keep. With an `and` node — keys `t`, `l`, `r` — every nested
 * `lit` loses its `v`, and `awake & sleeper` and `hibernating & sleeper`
 * serialise to the same string. Two unrelated expressions then share a cache
 * entry and one of them silently gets the other's recipients.
 */
export function canonicalAstKey(node) {
  if (node === null || typeof node !== 'object') return JSON.stringify(node)
  if (Array.isArray(node)) return `[${node.map(canonicalAstKey).join(',')}]`
  const keys = Object.keys(node).sort()
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalAstKey(node[k])}`).join(',')}}`
}

/**
 * Does this expression name the evaluating agent itself — `me`?
 *
 * The companion to `astReadsSubscriberLabels`. Both ask the same question about
 * a different construct: does this expression only have meaning relative to some
 * agent. `my_labels` reads that agent's labels, `me` reads its identity, and
 * either makes the answer a function of the scope as well as the expression.
 *
 * A caller that resolves or caches a set needs this to know the scope belongs in
 * the key. Neither construct makes an expression unanswerable or uncacheable —
 * two scopes are two sets.
 */
export function astReadsScopeIdentity(ast) {
  if (!ast) return false
  switch (ast.t) {
    case 'lit': return ast.v === 'me'
    case 'me': return true
    case 'not':
    case 'from':
    case 'to':
    case 'involving': return astReadsScopeIdentity(ast.x)
    case 'and':
    case 'or': return astReadsScopeIdentity(ast.l) || astReadsScopeIdentity(ast.r)
    default: return false
  }
}

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

/**
 * The terms a sender actually wrote in an address.
 *
 * An address is an expression — `awake`, `recon-lead`, `helm | skip`,
 * `awake & !goose` — and this is the set of labels it names, ignoring anything
 * under a negation. `!goose` says who is excluded, not who was written to, so a
 * subscription to `goose` must not match a message that went out of its way to
 * exclude them.
 */
export function addressTerms(ast) {
  return collectTerms(ast, { includeNegated: false })
}

/**
 * The terms whose meaning this expression DEPENDS on — every literal it names,
 * including the negated ones.
 *
 * This is the invalidation question, and it is deliberately not the addressing
 * question above. `awake & !goose` is not addressed to goose, so `addressTerms`
 * drops it and must keep dropping it. But its resolved membership absolutely
 * does depend on goose: relabel goose and the answer changes. A cache keyed off
 * `addressTerms` would never be invalidated by the very agent the expression
 * names, and would serve a stale set indefinitely.
 *
 * The two questions coincide on every expression without a negation, which is
 * exactly what makes reusing the wrong one hard to notice. One traversal,
 * parameterised, so the difference is stated at the call site instead of living
 * in a second copy that drifts.
 */
export function dependencyTerms(ast) {
  return collectTerms(ast, { includeNegated: true })
}

function collectTerms(ast, { includeNegated }) {
  const out = new Set()
  const walk = (n, negated) => {
    if (!n) return
    switch (n.t) {
      case 'lit': if (includeNegated || !negated) out.add(n.v); return
      case 'not': return walk(n.x, !negated)
      case 'and':
      case 'or': walk(n.l, negated); walk(n.r, negated); return
      case 'to':
      case 'from':
      case 'involving': return walk(n.x, negated)
      default: return
    }
  }
  walk(ast, false)
  return out
}

/**
 * `envelope` is the address the sender wrote, from `addressTerms`. When it is
 * supplied, `to:` asks what the message was addressed to; without it, `to:` falls
 * back to what the recipient happens to carry.
 *
 * Those are different questions and only the first is what the words say. Asking
 * the second makes a broadcast to `awake` match every subscription an awake agent
 * holds — including one meant for its own mail — because by then the address is
 * gone and all that is left is a list of people who received it. Skip's image:
 * the letter went to a building, and we were reading the tenant list instead of
 * the envelope.
 */
export function evalExprDirectional(ast, { fromLabels = [], toLabels = [], subscriberLabels = [], subscriberIdentity = [], envelope = null } = {}) {
  if (!ast) return true
  const from = fromLabels instanceof Set ? fromLabels : new Set(fromLabels)
  const recipient = toLabels instanceof Set ? toLabels : new Set(toLabels)
  const to = envelope || recipient
  const subscriber = subscriberLabels instanceof Set ? subscriberLabels : new Set(subscriberLabels)
  const identity = subscriberIdentity instanceof Set ? subscriberIdentity : new Set(subscriberIdentity)
  const testLeaf = (tok) => {
    if (tok.startsWith('to:')) return to.has(tok.slice(3))
    if (tok.startsWith('from:')) return from.has(tok.slice(5))
    return from.has(tok) || to.has(tok)
  }
  // Against an envelope the question is "did they write something I answer to",
  // so a single named term is enough — `some`, not `every`. Against a recipient's
  // own label set it has to stay `every`, because there the test is standing in
  // for "this addressee is me" and any shared status label would otherwise make
  // every agent match every other one, which is the wiretap this had before.
  const namesAny = (candidates, labels) =>
    envelope
      ? [...candidates].some(label => labels.has(label))
      : (candidates.size > 0 && [...candidates].every(label => labels.has(label)))
  const agentExpr = (n, labels) => {
    switch (n.t) {
      case 'lit': return n.v === 'my_labels'
        ? namesAny(subscriber, labels)
        : labels.has(n.v)
      // `me` is the subscriber, not a label spelled "me". It read
      // `labels.has('me')` — a literal token test — so `to:me` matched only an
      // agent carrying a label spelled `me`, which is nobody. The token resolves
      // correctly in search and history, so it looked implemented everywhere it
      // was visible and was inert in the one place delivery is decided.
      //
      // The subscriber's identity is its name and its id together, because both
      // are ways of writing the same agent. Anchoring to one of them would let
      // the meaning of a name and the meaning of an id come apart, and they are
      // the same agent.
      case 'me': return namesAny(identity, labels)
      case 'my_labels': return namesAny(subscriber, labels)
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
      // `between` names the two participants, not the spelling used on the
      // envelope. A direct message addressed by fleet id is still between the
      // same two agents as one addressed by friendly name. History resolves
      // both names to participant ids; live delivery must use the resolved
      // recipient labels for the same reason.
      case 'between': return (agentExpr(n.l, from) && agentExpr(n.r, recipient)) || (agentExpr(n.r, from) && agentExpr(n.l, recipient))
      case 'not': return !ev(n.x)
      case 'and': return ev(n.l) && ev(n.r)
      case 'or': return ev(n.l) || ev(n.r)
      default: return false
    }
  }
  return ev(ast)
}
