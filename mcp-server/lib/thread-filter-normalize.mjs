import { parseSearchQuery } from '../../shared/fleet-search-query.mjs'
import { parseMessageFilter } from '../../shared/fleet-labels.mjs'

function decodeThreadFilterHtmlEntities(raw) {
  return String(raw ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, '&')
}

export function normalizeThreadFilterExpression(raw) {
  const filter = decodeThreadFilterHtmlEntities(raw)
  let queryParseError = null
  try {
    const parsed = parseSearchQuery(filter)
    if (!parsed.query && parsed.filters.filterExpression) return parsed.filters.filterExpression
  } catch (e) {
    queryParseError = e
  }
  try {
    parseMessageFilter(filter)
    return filter
  } catch (e) {
    throw queryParseError || e
  }
}
