import { parseAgentSelector as parseUnifiedAgentSelector, parseUnifiedFilter } from './unified-filter-grammar.mjs'

const FILTER_KEYS = new Set(['from', 'to', 'involving', 'agent', 'since', 'after', 'before', 'type', 'role'])
const FILTER_OPERATORS = new Set(['&', '|', '!', '(', ')'])

export function parseSearchQuery(raw) {
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
    if (key === 'before') filters.before = token.slice(7)
    else if (key === 'after') filters.after = token.slice(6)
    else if (key === 'since') filters.since = token.slice(6)
    else if (key === 'type') filters.type = token.slice(5)

    if (key && key !== 'role') {
      if (key === 'since' || key === 'after' || key === 'before') continue
      const collected = collectFilterValue(parts, i)
      i = collected.nextIndex
      const normalized = normalizeSearchFilterToken(key, collected.valueTokens)
      filterParts.push(...normalized.filterTokens)
      if (key === 'from') filters.from = normalized.value
      else if (key === 'to') filters.to = normalized.value
      else if (key === 'agent') filters.agent = normalized.value
      continue
    }

    if (hasFilterTerm && FILTER_OPERATORS.has(token)) {
      filterParts.push(token)
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

  return { query: queryParts.join(' ').trim(), filters }
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
    since: (filters.since || filters.after) ? (resolveTimeFilter(filters.since || filters.after || '') || undefined) : undefined,
    before: filters.before ? (resolveTimeFilter(filters.before) || undefined) : undefined,
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
  const relMatch = lower.match(/^(\d+)([hdwm])$/)
  if (relMatch) {
    const n = parseInt(relMatch[1])
    const unit = relMatch[2]
    const d = new Date(now)
    if (unit === 'h') d.setHours(d.getHours() - n)
    else if (unit === 'd') d.setDate(d.getDate() - n)
    else if (unit === 'w') d.setDate(d.getDate() - n * 7)
    else if (unit === 'm') d.setMonth(d.getMonth() - n)
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
