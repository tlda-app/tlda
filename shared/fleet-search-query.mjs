import { JuxtapositionError, parseAgentSelector as parseUnifiedAgentSelector, parseUnifiedFilter } from './unified-filter-grammar.mjs'

/**
 * The caller's own tokens with `&` written in at the junctions they left bare,
 * as segments that say which operators the editor supplied. The UI renders the
 * supplied ones ghosted, so the parse is legible without having been typed.
 */
function explicitConjunctionSegments(parts, junctions) {
  const at = new Set(junctions)
  const segments = []
  parts.forEach((token, i) => {
    if (at.has(i)) segments.push({ text: '&', implied: true })
    segments.push({ text: token, implied: false })
  })
  return segments
}

function withExplicitConjunctions(parts, junctions) {
  return explicitConjunctionSegments(parts, junctions).map(s => s.text).join(' ')
}

const FILTER_KEYS = new Set(['from', 'to', 'involving', 'agent', 'project', 'since', 'after', 'before', 'type', 'role', 'id'])
const FILTER_OPERATORS = new Set(['&', '|', '!', '(', ')'])

// `agentSelector` is the search tool's `agent` parameter. It used to be spliced
// into the query string as `agent:(X) <query>`, which under a grammar that
// requires an operator is the caller's query with a juxtaposition prepended to
// it by us. It is composed onto the parsed expression instead.
// `autoConjoin` is the editor's affordance and nothing else's: with it, a bare
// space between two filter terms becomes the `&` the grammar requires, and the
// caller can render `explicitQuery` to show what its space produced. The API
// leaves it off, so a query sent programmatically is rejected rather than
// quietly rewritten — there is one language, and only the box is forgiving about
// how you type it.
export function parseSearchQuery(raw, { agentSelector = null, autoConjoin = false } = {}) {
  const quotedAt = new Set()
  const parts = splitSearchTokens(raw, quotedAt)
  const filters = {}
  const filterParts = []
  const queryParts = []
  // `& | ! ( )` are the filter language's operators, but the same characters
  // occur in ordinary prose ("wow!"). They bind to the filter language only when
  // there is one — so a query with no filter term keeps them as text, exactly as
  // before, and a query with one gets working `|` and `!` instead of an operator
  // dropped into the free-text side, where `from:a | from:b` died on
  // `filter parse error: unexpected "|"`.
  const hasFilterTerm = parts.some(part => filterKey(part))
  // Junctions where the caller abutted two filter terms. Recorded against the
  // token stream so the suggestion can be built from what they actually typed
  // rather than from the expression assembled here.
  const impliedConjunctionAt = []
  let lastEmittedWasFilterTerm = false

  for (let i = 0; i < parts.length; i++) {
    const token = parts[i]
    const key = filterKey(token)
    if (key === 'role') {
      // `role:` is lifted out of the expression into its own wire parameter,
      // because the expression language has no role term. Lifting it out silently
      // left whatever joined it behind: `from:skip & role:user` emitted
      // `"from: skip &"` and died on "unexpected end of", and `role:user &
      // from:skip` emitted a leading `&`. Measured against all eleven other
      // filter keys in both orders on 2026-09-12 — every pair containing `role:`
      // was a parse error, so `role:` could not be combined with anything at all,
      // and the message quoted the mangled internal string rather than what the
      // caller typed.
      //
      // The join goes with it, but only where that is honest. `role` is ANDed
      // against everything else at the wire, so an `&` beside it is redundant and
      // dropping it means exactly what the caller wrote. Under `|` or `!` it is
      // not expressible at all — there is no way to OR a wire parameter against
      // an expression term — and quietly treating it as an AND would answer a
      // different question, so that is refused in the caller's own words.
      const prev = filterParts[filterParts.length - 1]
      const next = parts[i + 1]
      const badJoin = (prev === '|' || prev === '!') ? prev : (next === '|' ? next : null)
      if (badJoin) {
        throw new Error(
          `"${token}" cannot be combined with "${badJoin}" in "${raw}". `
          + `role: selects which kind of entry to search and is applied to every match, `
          + `so it can only narrow a query — write it with "&", or drop it and filter the results.`,
        )
      }
      filters.role = token.slice(5)
      if (prev === '&') filterParts.pop()
      else if (next === '&') i++
      continue
    }
    if (key === 'type') filters.type = token.slice(5)

    if (key && key !== 'role') {
      // `since:`/`before:` are terms in the expression like every other filter,
      // not values lifted out of it. Lifting them out is what let
      // `to:me since:30m` look like a single term and pass, and it is why the
      // same word meant two different spans depending on which channel carried
      // it. The value is resolved to an absolute timestamp here because the
      // evaluator compares it against `row.timestamp` as a string.
      if (key === 'since' || key === 'after' || key === 'before') {
        if (lastEmittedWasFilterTerm) {
        impliedConjunctionAt.push(i)
        if (autoConjoin) filterParts.push('&')
      }
        const raw = token.slice(token.indexOf(':') + 1)
        const resolved = resolveTimeFilter(raw)
        if (!resolved) throw new Error(`"${token}" is not a time I can read. Use an ISO timestamp, "now", "today", "yesterday", or a relative span like 30s, 30m, 2h, 3d, 1w, 3mo.`)
        filterParts.push(`${key === 'after' ? 'since' : key}:${resolved}`)
        lastEmittedWasFilterTerm = true
        continue
      }
      if (lastEmittedWasFilterTerm) {
        impliedConjunctionAt.push(i)
        if (autoConjoin) filterParts.push('&')
      }
      const collected = collectFilterValue(parts, i)
      i = collected.nextIndex
      const normalized = normalizeSearchFilterToken(key, collected.valueTokens)
      filterParts.push(...normalized.filterTokens)
      lastEmittedWasFilterTerm = true
      if (key === 'from') filters.from = normalized.value
      else if (key === 'to') filters.to = normalized.value
      else if (key === 'agent') filters.agent = normalized.value
      else if (key === 'project') {
        filters.project = normalized.value
        filters.agent = `project:${normalized.value}`
      }
      continue
    }

    if (hasFilterTerm && FILTER_OPERATORS.has(token)) {
      // An operator belongs to the filter expression only when it actually joins
      // filter terms. If either side is a bare word, the caller has written
      // something the language cannot mean — most often a mistyped key, like
      // `sinse:30m & to:me` — and saying so is the whole point. Dropping the
      // operator instead would quietly turn their `|` into an `&`.
      if (token !== ')' && token !== '(' && token !== '!') {
        const orphan = !lastEmittedWasFilterTerm
          ? queryParts[queryParts.length - 1]
          : (nextFilterishToken(parts, i) ? null : parts[i + 1])
        if (orphan != null) {
          throw new Error(`"${orphan}" is not a filter term, so "${token}" has nothing to join in "${raw}". Filter keys are ${[...FILTER_KEYS].map(k => `${k}:`).join(', ')} — or quote the term to search it as text.`)
        }
      }
      filterParts.push(token)
      // `)` closes a term; every other operator joins or negates one, so what
      // follows is not an abutting term.
      lastEmittedWasFilterTerm = token === ')'
      continue
    }
    if (token === '&') continue
    if (token === '<>' && queryParts.length > 0 && parts[i + 1]) {
      const left = queryParts.pop()
      filterParts.push(left, '<>', parts[++i])
      continue
    }
    if (token.includes('<>')) {
      filterParts.push(token)
      continue
    }
    // A token one keystroke off a filter key is a dropped constraint, and the
    // quietest kind: `sinse:2h build` searched for the literal text "sinse:2h"
    // and answered "No results" with no indication that the time bound had been
    // read as a word. The caller gets a confident, well-formed, wrong answer —
    // and `from:X & build` is REFUSED for juxtaposition in the same breath, so
    // the strictness was landing on the correct query and not the typo.
    //
    // Only near misses, and only unquoted: `https://…` and ordinary prose
    // colons must still be searchable as text, and `"sinse:2h"` in quotes is an
    // explicit statement that it is text.
    if (!quotedAt.has(i)) {
      const meant = nearestFilterKey(token)
      if (meant) {
        throw new Error(
          `"${token}" is not a filter term — did you mean "${meant}:"? `
          + `Filter keys are ${[...FILTER_KEYS].map(k => `${k}:`).join(', ')}. `
          + `If you meant to search for that text, quote it: "${token}".`,
        )
      }
    }
    queryParts.push(token)
  }

  const explicitQuery = impliedConjunctionAt.length > 0
    ? withExplicitConjunctions(parts, impliedConjunctionAt)
    : raw
  if (impliedConjunctionAt.length > 0 && !autoConjoin) {
    throw new JuxtapositionError(raw, impliedConjunctionAt[0], explicitQuery)
  }

  if (agentSelector) {
    filterParts.unshift('involving:', '(', agentSelector, ')', ...(filterParts.length ? ['&'] : []))
    filters.agent = agentSelector
  }

  if (filterParts.length > 0) {
    const expression = filterParts.join(' ')
    const ast = parseUnifiedFilter(expression, { sort: 'message' })
    filters.filterExpression = expression
    // The ids the query names outright. A caller renders those rows whole:
    // `id:` is a dereference, and a snippet of a message you asked for by name
    // is not the message. Everything else still snippets.
    const named = messageIdsNamed(ast)
    if (named.length) filters.messageIds = named
  }

  if (filterParts.length === 0 && queryParts.length > 0) {
    const naturalAgentQueries = queryParts.filter(isNaturalAgentCandidate)
    if (naturalAgentQueries.length > 0) {
      filters.naturalAgentQueries = naturalAgentQueries
      filters.naturalAgentQuery = naturalAgentQueries[0]
      const naturalTextParts = queryParts.filter(token => !shouldTreatAsStructuredNaturalAgentToken(token, queryParts.length))
      filters.naturalTextQuery = naturalTextParts.join(' ').trim()
    }
  }

  const selector = filters.agent ?? filters.from ?? filters.to
  if (selector && !isExplicitFleetId(selector)) {
    filters.agentResolve = parseAgentSelector(selector, filters.from ? 'from' : filters.to ? 'to' : 'any')
  }

  return {
    query: queryParts.join(' ').trim(),
    filters,
    explicitQuery,
    explicitSegments: explicitConjunctionSegments(parts, impliedConjunctionAt),
  }
}

/**
 * Every id an `id:` term names positively, in walk order. A negated term names
 * no row it could return, so `not` is not descended into.
 */
function messageIdsNamed(node, out = []) {
  if (!node) return out
  switch (node.t) {
    case 'id':
      out.push(node.v)
      return out
    case 'and':
    case 'or':
      messageIdsNamed(node.l, out)
      messageIdsNamed(node.r, out)
      return out
    default:
      return out
  }
}

export function parseAgentSelector(raw, scope = 'any') {
  const parsed = parseUnifiedAgentSelector(raw)
  return {
    fragment: parsed?.fragment ?? String(raw || '').trim(),
    scope,
    expansion: 'stack',
    match: parsed?.match ?? 'auto',
    ...(parsed?.position != null ? { position: parsed.position } : {}),
    ...(parsed?.range ? { range: parsed.range } : {}),
  }
}

export function buildFleetSearchFilters(filters) {
  const nameSel = filters.agent ?? filters.from ?? filters.to
  const explicitId = nameSel && isExplicitFleetId(nameSel) ? nameSel : undefined
  const agentResolve = !explicitId ? filters.agentResolve : undefined
  const payload = {
    agent: explicitId,
    agentIdentityQuery: !!filters.agent,
    agentQuery: !filters.filterExpression ? agentResolve?.fragment : undefined,
    agentResolve,
    naturalAgentQuery: filters.naturalAgentQuery,
    naturalAgentQueries: filters.naturalAgentQueries,
    naturalTextQuery: filters.naturalTextQuery,
    fromOnly: !filters.agent && !!filters.from && !filters.filterExpression,
    role: filters.role,
    filterExpression: filters.filterExpression,
    eventType: filters.type,
    project: filters.project,
  }
  for (const key of Object.keys(payload)) {
    if (payload[key] == null || payload[key] === false || payload[key] === '') delete payload[key]
  }
  return payload
}

export function rankSearchResults(results, query) {
  const q = query.trim().toLowerCase()
  if (!q) return results
  const terms = q.split(/\s+/).filter(Boolean)
  return results
    .map((result, index) => ({ result, index, score: scoreResult(result, q, terms) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const bt = b.result.timestamp ?? ''
      const at = a.result.timestamp ?? ''
      const tc = bt.localeCompare(at)
      return tc || a.index - b.index
    })
    .map(x => x.result)
}

export function groupFleetSearchResults(results) {
  const groups = [
    makeResultGroup('agents', 'Agents', 'Resolved agent identities matching the query'),
    makeResultGroup('conversation', 'Conversation', 'Fleet chat, reports, and delegated task messages'),
    makeResultGroup('documents', 'Documents', 'Indexed project source and document text'),
    makeResultGroup('sessions', 'Session Logs', 'Terminal and agent transcript matches'),
    makeResultGroup('activity', 'Activity', 'Tool calls and lower-signal operational events'),
  ]
  const byId = new Map(groups.map(group => [group.id, group]))
  for (const result of results || []) {
    byId.get(searchResultGroupId(result))?.results.push(result)
  }
  return groups.filter(group => group.results.length > 0)
}

export function resolveTimeFilter(val) {
  const now = new Date()
  const lower = String(val || '').toLowerCase()
  if (lower === 'now') return now.toISOString()
  if (lower === 'today') {
    const d = new Date(now); d.setHours(0, 0, 0, 0); return d.toISOString()
  }
  if (lower === 'yesterday') {
    const d = new Date(now); d.setDate(d.getDate() - 1); d.setHours(0, 0, 0, 0); return d.toISOString()
  }
  // `m` is MINUTES. It used to be months here while the `since` tool parameter
  // read the identical string as minutes, so `since:30m` in a query searched
  // thirty months and `since: "30m"` beside it searched thirty — the same word,
  // two spans, nothing saying which you got. Minutes is what the parameter has
  // always documented and what a duration means everywhere else; months are no
  // longer expressible, which is no loss to a chat search.
  // `mo` is months and must be tried before `m`, which is minutes. Months keep a
  // spelling of their own so that fixing the units costs nobody their meaning.
  // `s` is seconds, and it exists on both sides for the same reason `m` means
  // the same thing on both: a span written one way in a query and the identical
  // way in a `since` parameter must not mean two things, or be readable in one
  // channel and not the other.
  const relMatch = lower.match(/^(\d+)\s*(mo(?:nths?)?|s(?:ec(?:s|onds?)?)?|m(?:in(?:utes?)?)?|h(?:r(?:s)?|ours?)?|d(?:ays?)?|w(?:eeks?)?)$/)
  if (relMatch) {
    const n = parseInt(relMatch[1])
    const unit = relMatch[2].startsWith('mo') ? 'mo' : relMatch[2][0]
    const d = new Date(now)
    if (unit === 'mo') d.setMonth(d.getMonth() - n)
    else if (unit === 's') d.setSeconds(d.getSeconds() - n)
    else if (unit === 'm') d.setMinutes(d.getMinutes() - n)
    else if (unit === 'h') d.setHours(d.getHours() - n)
    else if (unit === 'd') d.setDate(d.getDate() - n)
    else if (unit === 'w') d.setDate(d.getDate() - n * 7)
    return d.toISOString()
  }
  const parsed = new Date(val)
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  return null
}

// Returns the tokens, plus the indices that arrived quoted — quoting is how you
// say "this is text, not syntax", and the quotes are stripped here, so the fact
// has to travel alongside.
function splitSearchTokens(raw, quotedAt) {
  const matched = String(raw || '').match(/"[^"]*"|<>|[()&|!]|[^\s()&|!]+/g) ?? []
  return matched.map((t, i) => {
    if (t.startsWith('"') && t.endsWith('"')) {
      quotedAt?.add(i)
      return t.slice(1, -1)
    }
    return t
  })
}

/** The next real operand after `i`, skipping `!` and `(` — or null if it is not a filter term. */
function nextFilterishToken(parts, i) {
  for (let j = i + 1; j < parts.length; j++) {
    if (parts[j] === '!' || parts[j] === '(') continue
    return filterKey(parts[j]) ? parts[j] : null
  }
  return null
}

function filterKey(token) {
  const idx = token.indexOf(':')
  if (idx <= 0) return null
  const key = token.slice(0, idx).toLowerCase()
  return FILTER_KEYS.has(key) ? key : null
}

/**
 * Whether a token that resolved to no agent looks like a mistyped filter key —
 * `sinse:30m`, `cwd:/path`. It is only ever a HINT on the failure message, never
 * a syntax rule: a name is an opaque atom here, so `chief:day` is one whole name
 * and the grammar cannot tell it from a typo. Rejecting colon tokens outright
 * would make that documented name unsearchable.
 */
export function looksLikeMistypedFilterKey(token) {
  const match = /^([a-z][a-z0-9_]*):/i.exec(String(token || ''))
  if (!match) return false
  const key = match[1].toLowerCase()
  return !FILTER_KEYS.has(key) && key !== 'fleet'
}

// Damerau rather than plain Levenshtein, because an adjacent transposition is
// the commonest typo of all and plain Levenshtein scores it 2: `form:` for
// `from:` would have slipped through and been searched as text, which is the
// exact failure this is here to catch.
function editDistanceWithin(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false
  const rows = [Array.from({ length: b.length + 1 }, (_, j) => j)]
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) {
      row[j] = a[i - 1] === b[j - 1]
        ? rows[i - 1][j - 1]
        : 1 + Math.min(rows[i - 1][j], row[j - 1], rows[i - 1][j - 1])
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(row[j], rows[i - 2][j - 2] + 1)
      }
    }
    rows.push(row)
  }
  return rows[a.length][b.length] <= max
}

/**
 * The filter key a token was probably reaching for, or null.
 *
 * Deliberately a NEAR-miss test rather than "not a known key". Any `word:` shape
 * that is not a filter key would include `https://example.com` and every
 * ordinary colon in prose, and refusing those would break searching for text
 * that happens to contain one. So this only answers for something close enough
 * to a real key to be a typo: one edit away, or a prefix of at least three
 * characters (`proj:` for `project:`).
 */
export function nearestFilterKey(token) {
  const match = /^([a-z][a-z0-9_]*):/i.exec(String(token || ''))
  if (!match) return null
  const key = match[1].toLowerCase()
  if (FILTER_KEYS.has(key) || key === 'fleet') return null
  for (const candidate of FILTER_KEYS) {
    if (key.length >= 3 && candidate.startsWith(key)) return candidate
    if (editDistanceWithin(key, candidate, 1)) return candidate
  }
  return null
}

function collectFilterValue(parts, index) {
  const token = parts[index]
  const idx = token.indexOf(':')
  const rest = token.slice(idx + 1)
  if (rest) return { valueTokens: [rest], nextIndex: index }
  if (parts[index + 1] === '(') {
    const valueTokens = []
    let depth = 0
    for (let j = index + 1; j < parts.length; j++) {
      const part = parts[j]
      if (part === '(') depth++
      if (part === ')') depth--
      valueTokens.push(part)
      if (depth === 0) return { valueTokens, nextIndex: j }
    }
    return { valueTokens, nextIndex: parts.length - 1 }
  }
  return { valueTokens: parts[index + 1] ? [parts[index + 1]] : [], nextIndex: parts[index + 1] ? index + 1 : index }
}

function normalizeSearchFilterToken(key, valueTokens) {
  const normalizedKey = key === 'agent' || key === 'project' ? 'involving' : key === 'after' ? 'since' : key
  const value = valueTokens.join(' ').trim()
  if (key === 'project') {
    return { value, filterTokens: [`involving:project:${value}`] }
  }
  if (normalizedKey === 'id') {
    return { value, filterTokens: [`${normalizedKey}:${value}`] }
  }
  if (normalizedKey === 'type') {
    return { value, filterTokens: [`${normalizedKey}:${value}`] }
  }
  return {
    value,
    filterTokens: valueTokens.length ? [`${normalizedKey}:`, ...valueTokens] : [`${normalizedKey}:`],
  }
}

function isExplicitFleetId(value) {
  return value.startsWith('fleet:')
}

function isNaturalAgentCandidate(value) {
  return !!parseUnifiedAgentSelector(value) || /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(String(value || ''))
}

function shouldTreatAsStructuredNaturalAgentToken(value, tokenCount) {
  if (tokenCount === 1) return true
  return !!parseUnifiedAgentSelector(value) || /[-_:~]/.test(String(value || ''))
}

function scoreResult(result, query, terms) {
  const serverScore = Number(result?.score)
  const base = normalizeServerScore(result, serverScore)
  const haystack = `${result.snippet || ''}\n${result.text || ''}`.toLowerCase()
  let score = base
  if (haystack.includes(query)) score += 1000
  for (const term of terms) {
    if (haystack.includes(term)) score += 20
  }
  if (terms.length > 0 && terms.every(term => haystack.includes(term))) score += 100
  score += searchResultModalityBoost(result)
  return score
}

function normalizeServerScore(result, serverScore) {
  if (!Number.isFinite(serverScore)) return 0
  if (result?.type === 'document_content') return Math.min(serverScore, 40)
  return serverScore
}

function searchResultModalityBoost(result) {
  if (result?.source === 'fleet' && result?.type === 'chat') return 80
  if (result?.source === 'fleet' && result?.type === 'report') return 55
  if (result?.source === 'fleet' && result?.type === 'delegate') return 45
  if (result?.type === 'project_agent') return 40
  if (result?.type === 'document_content') return 20
  if (result?.source === 'session') return -20
  if (result?.type === 'activity') return -60
  return 0
}

function makeResultGroup(id, label, detail) {
  return { id, label, detail, results: [] }
}

function searchResultGroupId(result) {
  if (result?.type === 'project_agent') return 'agents'
  if (result?.type === 'document_content') return 'documents'
  if (result?.source === 'session') return 'sessions'
  if (result?.type === 'activity') return 'activity'
  return 'conversation'
}
