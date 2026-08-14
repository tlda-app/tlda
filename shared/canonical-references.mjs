const EVENT_TYPE_RE = /^[a-z][a-z0-9_-]*$/
const EVENT_ID_RE = /^\d+$/
const SEARCH_ID_RE = /^(msg|session):(\d+)$/

export function canonicalEventReference(type, id) {
  const eventType = String(type || '').trim()
  const eventId = String(id ?? '').trim()
  if (!EVENT_TYPE_RE.test(eventType) || !EVENT_ID_RE.test(eventId)) return null
  return `${eventType}#${eventId}`
}

export function parseCanonicalEventReference(value) {
  const text = String(value || '').trim()
  const hash = text.indexOf('#')
  if (hash <= 0 || text.indexOf('#', hash + 1) !== -1) return null
  const type = text.slice(0, hash)
  const id = text.slice(hash + 1)
  return canonicalEventReference(type, id) ? { type, id: Number(id), canonical: text } : null
}

export function canonicalSearchReference(source, id) {
  const searchId = `${String(source || '').trim()}:${String(id ?? '').trim()}`
  return SEARCH_ID_RE.test(searchId) ? `search#${searchId}` : null
}

export function parseCanonicalSearchReference(value) {
  const text = String(value || '').trim()
  if (!text.startsWith('search#')) return null
  const match = text.slice('search#'.length).match(SEARCH_ID_RE)
  if (!match) return null
  return { source: match[1], id: Number(match[2]), canonical: text }
}

export function parseCanonicalReference(value) {
  return parseCanonicalEventReference(value) || parseCanonicalSearchReference(value)
}

export const CANONICAL_REFERENCE_SOURCE = String.raw`\b(?:[a-z][a-z0-9_-]*#\d+|search#(?:msg|session):\d+)\b`
