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
  if (!id && !glyph) return null
  return { kind: 'glyph', id, glyph }
}

export function pretty_name_parts(pretty_name) {
  if (pretty_name == null || pretty_name === '') return []
  const rawParts = Array.isArray(pretty_name) ? pretty_name : [pretty_name]
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
  return parts
}

export function pretty_name_plain_text(pretty_name) {
  return pretty_name_parts(pretty_name)
    .map(part => typeof part === 'string' ? part : (part.glyph || ''))
    .filter(Boolean)
    .join(' ')
    .trim()
}
