// voice-keyterms.mjs — turn the live agent roster into spoken-form names for
// Deepgram keyterm prompting.
//
// Skip, 2026-04-06 23:12: "So commands are crucial. It seems like we could have
// all current and stale agent names."
//
// This seeds the recognizer; it never edits text. That distinction is the whole
// point. On 2026-06-26 Skip rejected the find-replace approach outright ("Like
// why are you building a fucking list"), and a rewrite list could not be made
// safe here anyway: `brief`, `anger`, `dig`, `fix` and `helm` are all agent
// names and all ordinary English words, so any rule matching them would clobber
// speech he meant. Boosting biases what Deepgram hears and can rewrite nothing.
//
// The token budget and the merge with the math vocabulary live bridge-side, in
// bin/deepgram-runtime/keyterm-budget.mjs — the bridge owns that vocabulary and
// ships as its own image.

import { isRuntimeAwake } from '../shared/fleet-runtime-status.mjs'

function agentName(agent) {
  const name = agent?.friendly_name
  return typeof name === 'string' ? name.trim() : ''
}

// Agent names are hyphenated slugs; Skip speaks them as words. "opus-chief-
// successor" is said "opus chief successor", so that is what Deepgram is primed
// for.
function spokenForm(name) {
  return name.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
}


/**
 * Ordered keyterm candidates from the roster.
 *
 * Order is the drop order: the bridge truncates the tail when Deepgram's token
 * budget runs out, and it runs out early — the fleet has minted well over a
 * thousand agents, so only a few dozen terms ever fit. Two consequences drive
 * this ordering:
 *
 * Awake agents first, because those are the ones Skip is addressing.
 *
 * Each agent contributes its whole name AND its parts together, rather than all
 * whole names first. Skip says "the agent chief", not "opus chief successor" —
 * the short form is the one that has to be boosted, and putting segments in a
 * second pass meant the budget was exhausted by whole names before a single
 * segment was reached. Truncation now drops whole agents off the tail instead
 * of dropping every short form.
 */
export function agentKeytermNames(agents) {
  const awake = []
  const rest = []
  for (const agent of agents || []) (isRuntimeAwake(agent) ? awake : rest).push(agent)

  const candidates = []
  for (const agent of [...awake, ...rest]) {
    const name = spokenForm(agentName(agent))
    if (!name) continue
    candidates.push(name)
    const parts = name.split(' ')
    if (parts.length < 2) continue
    for (const part of parts) {
      if (part.length >= 3 && !/^\d+$/.test(part)) candidates.push(part)
    }
  }
  return candidates
}
