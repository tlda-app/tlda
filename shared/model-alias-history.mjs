// Retired model aliases, resolved to their current alias at READ time.
//
// `metadata.model` on a server agent row records, by alias, the model the
// agent ran under — frozen at mint, never rewritten. A rename therefore
// splits the fleet into before-and-after: rows minted under the old alias
// keep it forever, and every surface that prints the recorded string shows
// two names for one model (2026-09-26: `muse-meta` rows beside `muse` rows,
// all `muse-spark-1.3-contributor`).
//
// The fix is not another migration — the next rename would need one again.
// Readers resolve the recorded string through this map before display, so a
// rename is one entry here and every surface shows the current name without
// touching a row. On the next rename, add the retired alias as a key mapped
// to the alias that replaced it; nothing else changes.
//
// Keys are exact recorded strings. Values must be live ledger aliases.
// Consumers: the agents panel (`formatFleetAgentModel`) and the fleet-table
// roster (`fleet-roster-truth.mjs`).
export const RETIRED_MODEL_ALIASES = {
  // 2026-09-26: `muse-meta` (Meta harness) became `muse`; the old
  // Claude-harness `muse` became `muse-claude` and was then removed.
  'muse-meta': 'muse',
}

export function resolveModelAlias(name) {
  if (name == null) return name
  const key = String(name)
  return Object.hasOwn(RETIRED_MODEL_ALIASES, key) ? RETIRED_MODEL_ALIASES[key] : key
}
