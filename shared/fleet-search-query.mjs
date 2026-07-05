import { parseAgentSelector as parseUnifiedAgentSelector, parseUnifiedFilter } from './unified-filter-grammar.mjs'

const FILTER_KEYS = new Set(['from', 'to', 'involving', 'agent', 'since', 'after', 'before', 'type', 'role'])

export function parseSearchQuery(raw) {
  const parts = splitSearchTokens(raw)
  const filters = {}
  const filterParts = []
  const queryParts = []

  for (let i = 0; i < parts.length; i++) {
    const token = parts[i]
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
      const normalized = normalizeSearchFilterToken(token)
      filterParts.push(normalized)
      if (key === 'from') filters.from = token.slice(5)
      else if (key === 'to') filters.to = token.slice(3)
      else if (key === 'agent') filters.agent = token.slice(6)
      continue
    }

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

  if (filterParts.length === 0 && queryParts.length === 1 && isNaturalAgentCandidate(queryParts[0])) {
    filters.naturalAgentQuery = queryParts[0]
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
    ...(parsed?.phase ? { phase: parsed.phase } : {}),
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

export function resolveTimeFilter(val) {
  const now = new Date()
  const lower = String(val || '').toLowerCase()
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

function splitSearchTokens(raw) {
  return String(raw || '').match(/"[^"]+"|\S+/g)?.map(t => t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t) ?? []
}

function filterKey(token) {
  const idx = token.indexOf(':')
  if (idx <= 0) return null
  const key = token.slice(0, idx).toLowerCase()
  return FILTER_KEYS.has(key) ? key : null
}

function normalizeSearchFilterToken(token) {
  if (token.startsWith('agent:')) return `involving:${token.slice(6)}`
  if (token.startsWith('after:')) return `since:${token.slice(6)}`
  return token
}

function isExplicitFleetId(value) {
  return value.startsWith('fleet:')
}

function isNaturalAgentCandidate(value) {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(String(value || ''))
}

function scoreResult(result, query, terms) {
  const haystack = `${result.snippet || ''}\n${result.text || ''}`.toLowerCase()
  let score = 0
  if (haystack.includes(query)) score += 1000
  for (const term of terms) {
    if (haystack.includes(term)) score += 20
  }
  if (terms.length > 0 && terms.every(term => haystack.includes(term))) score += 100
  return score
}
