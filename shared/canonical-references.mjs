const EVENT_TYPE_RE = /^[a-z][a-z0-9_-]*$/
const EVENT_ID_RE = /^\d+$/

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

export const CANONICAL_EVENT_REFERENCE_SOURCE = String.raw`\b[a-z][a-z0-9_-]*#\d+\b`
