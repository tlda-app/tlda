/**
 * lineage-name.mjs — the lineage naming convention, in one place.
 *
 * Lineage is a friendly-name convention, NOT a server data model. The server
 * stores only `friendly_name`; it knows nothing about "phase". A lineage is a
 * triple of friendly names that rotate on handoff, and the phase (dawn / day /
 * dusk) is ENCODED IN THE NAME:
 *
 *   dawn  → bare base name        e.g. "conc5"        (the default worker, no icon)
 *   day   → base + ":day"         e.g. "conc5:day"    (the manager)
 *   dusk  → base + ":dusk"        e.g. "conc5:dusk"   (the consultant on the way out)
 *
 * Only three areas ever read this: search (lineage), handoff (rotation), and
 * display (parse phase → icon, strip suffix → pretty name). Everything general
 * — storage, chat routing, lifecycle — stays blind to it.
 *
 * Imported by the client (Vite), the server (Node), the MCP server, and eliza —
 * keep it dependency-free.
 */

export const PHASES = Object.freeze(['dawn', 'day', 'dusk'])

/** The non-dawn phases carry an explicit ":<phase>" suffix; dawn is bare. */
const SUFFIX_RE = /:(day|dusk)$/

/**
 * The phase encoded in a friendly name. A bare name (no recognized suffix) is
 * `dawn` (the default). Returns null only when there is no name at all.
 */
export function phaseFromName(friendlyName) {
  if (!friendlyName) return null
  const m = SUFFIX_RE.exec(friendlyName)
  return m ? m[1] : 'dawn'
}

/** The base (lineage) name with any phase suffix stripped — what gets displayed. */
export function baseName(friendlyName) {
  if (!friendlyName) return friendlyName
  return friendlyName.replace(SUFFIX_RE, '')
}

/** Build the friendly name for a given base + phase (inverse of phaseFromName). */
export function nameForPhase(base, phase) {
  if (phase === 'day') return `${base}:day`
  if (phase === 'dusk') return `${base}:dusk`
  return base // dawn → bare
}
