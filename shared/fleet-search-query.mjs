import { JuxtapositionError, parseAgentSelector as parseUnifiedAgentSelector, parseUnifiedFilter } from './unified-filter-grammar.mjs'

/** The caller's own tokens with `&` written in at the junctions they left bare. */
function withExplicitConjunctions(parts, junctions) {
  const at = new Set(junctions)
  return parts.map((token, i) => (at.has(i) ? `& ${token}` : token)).join(' ')
}

const FILTER_KEYS = new Set(['from', 'to', 'involving', 'agent', 'since', 'after', 'before', 'type', 'role'])
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
    if (!quotedAt.has(i)) {
      const unknown = unknownFilterKey(token)
      if (unknown) {
        throw new Error(`unknown filter "${unknown}:" in "${raw}". Known filters: ${[...FILTER_KEYS].map(k => `${k}:`).join(', ')}. To search for this as text, quote it: "${token}"`)
      }
    }
    const key = filterKey(token)
    if (key === 'role') {
      filters.role = token.slice(5)
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
        if (!resolved) throw new Error(`"${token}" is not a time I can read. Use an ISO timestamp, "now", "today", "yesterday", or a relative span like 30m, 2h, 3d, 1w.`)
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
      continue
    }

    if (hasFilterTerm && FILTER_OPERATORS.has(token)) {
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
    parseUnifiedFilter(expression, { sort: 'message' })
    filters.filterExpression = expression
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

  return { query: queryParts.join(' ').trim(), filters, explicitQuery }
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
  const nameSel = filters.agent ?? filters.from
  const explicitId = nameSel && isExplicitFleetId(nameSel) ? nameSel : undefined
  const agentResolve = !explicitId ? filters.agentResolve : undefined
  const payload = {
    agent: explicitId,
    agentQuery: !filters.filterExpression ? agentResolve?.fragment : undefined,
    agentResolve,
    naturalAgentQuery: filters.naturalAgentQuery,
    naturalAgentQueries: filters.naturalAgentQueries,
    naturalTextQuery: filters.naturalTextQuery,
    fromOnly: !filters.agent && !!filters.from && !filters.filterExpression,
    role: filters.role,
    filterExpression: filters.filterExpression,
    eventType: filters.type,
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
  const relMatch = lower.match(/^(\d+)\s*(m(?:in(?:utes?)?)?|h(?:r(?:s)?|ours?)?|d(?:ays?)?|w(?:eeks?)?)$/)
  if (relMatch) {
    const n = parseInt(relMatch[1])
    const unit = relMatch[2][0]
    const d = new Date(now)
    if (unit === 'm') d.setMinutes(d.getMinutes() - n)
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

function filterKey(token) {
  const idx = token.indexOf(':')
  if (idx <= 0) return null
  const key = token.slice(0, idx).toLowerCase()
  return FILTER_KEYS.has(key) ? key : null
}

// Prefixes that look like a filter key and are not one: an agent id, and the URL
// schemes that turn up in ordinary message text.
const NON_FILTER_PREFIXES = new Set(['fleet', 'http', 'https', 'ws', 'wss', 'file', 'mailto'])

// A term shaped like a filter whose key nothing recognises — `sinse:30m`. It
// used to fall through to free text and match nothing, which is indistinguishable
// from a filter that legitimately found nothing, and that is what sends a caller
// off guessing search words instead of fixing the term. Quote it to search for
// the literal text.
function unknownFilterKey(token) {
  const match = /^([a-z][a-z0-9_]*):/i.exec(token)
  if (!match) return null
  const key = match[1].toLowerCase()
  if (FILTER_KEYS.has(key) || NON_FILTER_PREFIXES.has(key)) return null
  return key
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
  const normalizedKey = key === 'agent' ? 'involving' : key === 'after' ? 'since' : key
  const value = valueTokens.join(' ').trim()
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
  if (result?.type === 'document_content') return 'documents'
  if (result?.source === 'session') return 'sessions'
  if (result?.type === 'activity') return 'activity'
  return 'conversation'
}
