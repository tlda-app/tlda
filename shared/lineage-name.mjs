/**
 * Friendly-name suffix helpers.
 *
 * Agent identity is the exact `friendly_name`. Suffixes such as ":day" and
 * ":dusk" are just name endings: routing/filtering must use the full name, while
 * display may replace a recognized ending with a glyph. The only intentional
 * stripped-name use is scoped historical search / handoff rotation code.
 *
 * Imported by the client (Vite), the server (Node), the MCP server, and bots —
 * keep it dependency-free.
 */

// The rotation order. zombie is deliberately NOT here — it is out of rotation
// and only ever assigned by a manual resurrect.
export const PHASES = Object.freeze(['dawn', 'day', 'dusk', 'night'])

/** Every named phase, including the out-of-rotation zombie. */
export const ALL_PHASES = Object.freeze([...PHASES, 'zombie'])

/** The non-dawn phases carry an explicit ":<phase>" suffix; dawn is bare. */
const SUFFIX_RE = /:(day|dusk|night|zombie)$/

export const DISPLAY_SUFFIX_GLYPHS = Object.freeze([
  { suffix: ':day', key: 'day', glyph: '☀' },
  { suffix: ':dusk', key: 'dusk', glyph: '◐' },
  { suffix: ':night', key: 'night', glyph: '☾' },
  { suffix: ':zombie', key: 'zombie', glyph: '☠' },
])

export function displaySuffixForName(friendlyName) {
  if (!friendlyName) return null
  return DISPLAY_SUFFIX_GLYPHS.find(rule => friendlyName.endsWith(rule.suffix)) || null
}

export function splitDecoratedName(friendlyName) {
  const rule = displaySuffixForName(friendlyName)
  if (!rule) return { text: friendlyName || '', glyph: '', suffix: '', key: null }
  return {
    text: friendlyName.slice(0, -rule.suffix.length),
    glyph: rule.glyph,
    suffix: rule.suffix,
    key: rule.key,
  }
}

export function decoratedNameText(friendlyName) {
  const parts = splitDecoratedName(friendlyName)
  return parts.glyph ? `${parts.glyph} ${parts.text}` : parts.text
}

/**
 * The phase encoded in a friendly name. A bare name (no recognized suffix) is
 * `dawn` (the default). Returns null only when there is no name at all.
 */
export function phaseFromName(friendlyName) {
  if (!friendlyName) return null
  const m = SUFFIX_RE.exec(friendlyName)
  return m ? m[1] : 'dawn'
}

/** Stripped base name for scoped historical search / handoff rotation only. */
export function baseName(friendlyName) {
  if (!friendlyName) return friendlyName
  return friendlyName.replace(SUFFIX_RE, '')
}

/** Build the friendly name for a given base + phase (inverse of phaseFromName). */
export function nameForPhase(base, phase) {
  if (phase === 'day') return `${base}:day`
  if (phase === 'dusk') return `${base}:dusk`
  if (phase === 'night') return `${base}:night`
  if (phase === 'zombie') return `${base}:zombie`
  return base // dawn → bare
}
