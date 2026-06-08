/**
 * lineage-name.mjs — the lineage naming convention, in one place.
 *
 * Lineage is a friendly-name convention, NOT a server data model. The server
 * stores only `friendly_name`; it knows nothing about "phase". A lineage is a
 * chain of friendly names that rotate on handoff, and the phase (dawn / day /
 * dusk / night) is ENCODED IN THE NAME:
 *
 *   dawn  → bare base name        e.g. "conc5"        (the default worker, no icon)
 *   day   → base + ":day"         e.g. "conc5:day"    (the manager)
 *   dusk  → base + ":dusk"        e.g. "conc5:dusk"   (the consultant on the way out)
 *   night → base + ":night"       e.g. "conc5:night"  (last rung before aging out)
 *
 * Plus one phase that is NOT in the rotation:
 *   zombie → base + ":zombie"     e.g. "conc5:zombie" (manually resurrected after
 *                                                      it rotated out and died)
 *
 * Only three areas ever read this: search (lineage), handoff (rotation), and
 * display (parse phase → icon, strip suffix → pretty name). Everything general
 * — storage, chat routing, lifecycle — stays blind to it.
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
  if (phase === 'night') return `${base}:night`
  if (phase === 'zombie') return `${base}:zombie`
  return base // dawn → bare
}
