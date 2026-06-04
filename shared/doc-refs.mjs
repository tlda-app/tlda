/**
 * doc-refs.mjs — single source of truth for detecting document references
 * inside chat message text.
 *
 * Before this module the detection logic lived in two places that had drifted:
 *   - server (agent-facing): mcp-server/fleet-tools.mjs `resolveTheoremRefs`,
 *     whose number pattern accepts letter prefixes ("Lemma C5", "Lemma C.10").
 *   - client (Skip-facing): src/docLinks.ts `REF_PATTERNS`, whose theorem
 *     number pattern was digit-only (`\d+(?:\.\d+)*`) — so every appendix
 *     reference ("Lemma C5") rendered as dead text in Skip's chat view even
 *     though it resolved fine for the agent.
 *
 * One detector kills that asymmetry: both sides build their theorem matcher
 * from the constants here, so "what counts as a theorem reference" can't
 * disagree between the two contexts.
 *
 * Imported by both the server (.mjs, Node) and the bundled client
 * (src/docLinks.ts via Vite) — keep it dependency-free.
 */

/**
 * Reference env names → the LaTeX label-type prefixes they resolve against.
 * `names` are the words an author types in chat; `types` are the label `type`
 * values stored in the doc's source-map. The full table (theorem-like plus
 * appendix/section/equation) is the SERVER's taxonomy and is imported verbatim
 * by `resolveTheoremRefs`. Rows carrying an `envType` are the "theorem-like"
 * ones the CLIENT resolves through its theorem-map; the client ignores the
 * rest (it has its own section/equation matchers).
 */
export const REF_TYPES = Object.freeze([
  { names: ['lemma'], types: ['lem', 'lemm', 'lemma'], envType: 'lemma' },
  { names: ['theorem', 'thm'], types: ['thm', 'theorem'], envType: 'theorem' },
  { names: ['proposition', 'prop'], types: ['prop', 'proposition'], envType: 'proposition' },
  { names: ['corollary', 'cor'], types: ['cor', 'corollary'], envType: 'corollary' },
  { names: ['definition', 'def'], types: ['def', 'definition'], envType: 'definition' },
  { names: ['assumption'], types: ['a', 'ass', 'assumption'], envType: 'assumption' },
  { names: ['remark'], types: ['rem', 'remark'], envType: 'remark' },
  { names: ['example'], types: ['ex', 'example'], envType: 'example' },
  { names: ['appendix'], types: ['app', 'sec'] },
  { names: ['section', 'sec'], types: ['sec'] },
  { names: ['equation', 'eq'], types: ['eq'] },
])

/** The theorem-like subset (rows the client resolves via the theorem map). */
export const THEOREM_REF_TYPES = Object.freeze(REF_TYPES.filter(t => t.envType))

/**
 * The reference number sub-pattern. Matches a digit-only number ("3.1") OR a
 * letter-prefixed appendix number, with optional dot/space between the letter
 * and the digits: "C5", "C.10", "C 5", "A.1". Source string (not a RegExp) so
 * callers can splice it into a larger pattern with their own flags.
 */
export const REF_NUMBER_SRC = '[A-Z]?\\.?\\s?\\d[\\d.]*'

/**
 * Normalize a captured reference number to its canonical label form:
 * strip internal whitespace and insert the dot a LaTeX appendix number carries
 * ("C5" / "C 5" → "C.5"; "3.1" → "3.1"; "C.10" → "C.10").
 */
export function normalizeRefNumber(raw) {
  return String(raw)
    .trim()
    .replace(/\s+/g, '')
    .replace(/([A-Z])(\d)/i, '$1.$2')
    .toUpperCase()
}

/** Look up the REF_TYPES entry for an env word the author typed ("lem", "Lemma"). */
export function refTypeForName(name) {
  const lower = String(name).toLowerCase()
  return REF_TYPES.find(t => t.names.some(n => n === lower)) || null
}

/**
 * The LaTeX label-type prefixes a theorem-like envType resolves against
 * ("theorem" → ["thm", "theorem"], "proposition" → ["prop", "proposition"]).
 * Use this to match a theorem-map entry's `type` — a naive `envType.slice(0,3)`
 * is wrong ("theorem".slice(0,3) === "the" ≠ "thm").
 */
export function labelTypesForEnvType(envType) {
  const row = REF_TYPES.find(t => t.envType === envType)
  return row ? row.types : []
}

/**
 * A fresh global RegExp matching "EnvWord Number" with the shared number
 * pattern. Group 1 = env word, group 2 = raw number. Returns a NEW regex each
 * call (stateful `lastIndex` must not be shared across callers).
 *
 * `names` is the env-name list to match (default: all REF_TYPES names — what
 * the server wants). `tail` lets the server append its idempotence guard —
 * `(?!\\])(?! \\[)` — so it doesn't re-resolve text it already annotated.
 */
export function buildTheoremRefRegex(names = REF_TYPES.flatMap(t => t.names), tail = '') {
  return new RegExp(
    '\\b(' + names.join('|') + ')\\s+(' + REF_NUMBER_SRC + ')' + tail,
    'gi',
  )
}
