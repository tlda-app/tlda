// keyterm-budget.mjs — merge roster keyterms into the base vocabulary without
// exceeding Deepgram's keyterm ceiling.
//
// Deepgram caps keyterm prompting at 500 tokens across ALL keyterms and rejects
// the request above it: "Keyterm limit exceeded. The maximum number of tokens
// across all keyterms is 500." We do not have their tokenizer, so estimate high
// and sit under the ceiling — undercounting costs a refused connection, which
// takes Skip's microphone down.
export const KEYTERM_TOKEN_BUDGET = 400

// Deliberately pessimistic: a rare proper noun splits into more subword tokens
// than a common word does.
export function estimateKeytermTokens(term) {
  const words = String(term).trim().split(/\s+/).filter(Boolean)
  let total = 0
  for (const word of words) total += Math.max(1, Math.ceil(word.length / 4))
  return total
}

/**
 * Merge `names` (roster keyterms, already in drop order) into `base` (the
 * math/paper vocabulary).
 *
 * The base vocabulary is kept whole and is exempt from the budget check: it is
 * load-bearing for the writing Skip actually does, and dropping "Bregman" to
 * make room for an agent minted five minutes ago would be a bad trade. Roster
 * names fill whatever remains, in order, and the overflow is returned so the
 * caller can log the truncation rather than silently shortening the roster.
 */
export function mergeKeyterms(base = [], names = [], budget = KEYTERM_TOKEN_BUDGET) {
  const keyterms = []
  const seen = new Set()
  let spent = 0

  for (const term of base) {
    const text = String(term).trim()
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    keyterms.push(text)
    spent += estimateKeytermTokens(text)
  }

  const dropped = []
  for (const name of names) {
    const text = String(name).trim()
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    const cost = estimateKeytermTokens(text)
    if (spent + cost > budget) { dropped.push(text); continue }
    seen.add(key)
    keyterms.push(text)
    spent += cost
  }

  return { keyterms, dropped, estimatedTokens: spent }
}
