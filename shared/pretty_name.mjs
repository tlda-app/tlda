/**
 * Display-only pretty-name helpers.
 *
 * friendly_name is the exact behavioral name. It is the only value that may be
 * used for identity, filters, DMs, sync, routing, storage keys, or drag payloads.
 * pretty_name is supplied by the agent/bot and rendered only for presentation.
 */

function normalizeGlyph(part) {
  const id = part.id == null ? '' : String(part.id)
  const glyph = part.glyph == null ? '' : String(part.glyph)
  const label = part.label == null ? glyph || id : String(part.label)
  if (!id && !glyph && !label) return null
  return { kind: 'glyph', id, glyph, label }
}

export function pretty_name_parts(pretty_name, fallback = '') {
  const value = pretty_name == null || pretty_name === '' ? fallback : pretty_name
  const rawParts = Array.isArray(value) ? value : [value]
  const parts = []
  for (const part of rawParts) {
    if (part == null || part === '') continue
    if (typeof part === 'string') {
      parts.push(part)
    } else if (typeof part === 'object' && part.kind === 'glyph') {
      const glyph = normalizeGlyph(part)
      if (glyph) parts.push(glyph)
    } else {
      parts.push(String(part))
    }
  }
  if (!parts.length && fallback) parts.push(String(fallback))
  return parts
}

export function pretty_name_plain_text(pretty_name, fallback = '') {
  return pretty_name_parts(pretty_name, fallback)
    .map(part => typeof part === 'string' ? part : (part.glyph || part.label || part.id))
    .join(' ')
    .trim()
}
