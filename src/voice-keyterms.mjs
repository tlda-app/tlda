// voice-keyterms.mjs — the agents Skip is likely to say out loud, as Deepgram
// keyterms.
//
// Skip, 2026-07-31: "I don't want all current and stale agent names. I want
// just, like, all fucking agents I would be likely to be talking about — the
// agent names I would remember. Which would be, like, the 20 most recently
// active at a given time, or you could have this be project specific, or you
// could have it be based on the fucking chats I have. […] Usually there would
// be, like, five or six agents that would be relevant."
//
// This seeds the recognizer; it never edits text. That distinction is the whole
// point. On 2026-06-26 he rejected the find-replace approach outright ("Like why
// are you building a fucking list"), and a rewrite list could not be made safe
// here anyway: `brief`, `anger`, `dig`, `fix` and `helm` are all agent names and
// all ordinary English words, so any rule matching them would clobber speech he
// meant. Boosting biases what Deepgram hears and can rewrite nothing.
//
// Selection is his conversation first, roster recency as the floor. Fleet-wide
// activity alone is the wrong signal — a dozen agents can be busy in worktrees
// he has never addressed, and those are exactly the names that would crowd out
// the ones he says. But conversation alone is not enough either: the event store
// is fed from live WS *and* DB history (fleet-data.mjs:65), so how much is
// present depends on what panels have fetched, and right after a page load it
// can be thin. That is the moment he opens the page and starts talking, so the
// roster floor exists to guarantee the set is never empty then.
//
// Of the three options he offered, project-specific is deliberately not
// implemented: voice has no project context where dgStartMsg() runs, so
// honouring it would mean inventing plumbing to carry one.

// His five or six, with headroom. Not a budget limit — the budget stops binding
// at this size. A list padded with names he never says makes recognition worse
// for the ones he does.
export const KEYTERM_AGENT_LIMIT = 20

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

function eventTime(event) {
  const ts = Date.parse(event?.timestamp ?? '')
  return Number.isFinite(ts) ? ts : 0
}

function lastActive(agent) {
  const ts = Date.parse(agent?.last_active ?? '')
  return Number.isFinite(ts) ? ts : 0
}

// Agents he has actually exchanged messages with, most recent first. `to` and
// `from` carry either an id or a name depending on the event, so resolve both
// ways against the roster rather than assuming one.
function conversationPartners(events, humanId, byId, byName) {
  if (!humanId) return []
  const chats = []
  for (const event of events || []) {
    if (event?.type !== 'chat') continue
    const from = typeof event.from === 'string' ? event.from : ''
    const to = typeof event.to === 'string' ? event.to : ''
    if (from !== humanId && to !== humanId) continue
    const other = from === humanId ? to : from
    if (!other || other === humanId) continue
    chats.push([eventTime(event), other])
  }
  chats.sort((a, b) => b[0] - a[0])

  const partners = []
  const seen = new Set()
  for (const [, token] of chats) {
    const agent = byId.get(token) || byName.get(token.toLowerCase())
    if (!agent || seen.has(agent.id)) continue
    seen.add(agent.id)
    partners.push(agent)
  }
  return partners
}

/**
 * Ordered keyterm candidates: the agents in Skip's attention, whole names and
 * name parts together.
 *
 * Each agent contributes its whole name AND its parts. Skip says "the agent
 * chief", not "opus chief successor" — the short form is the one that has to be
 * boosted.
 *
 * Order is the drop order for the bridge's token budget. At this list size the
 * budget will not fire, but the ordering stays meaningful because the roster
 * floor could pad an unusual session, and a silent overflow would look exactly
 * like the feature not working.
 *
 * Known limit: an agent that has never been messaged and is not yet on the
 * roster cannot be boosted. "Spawn an agent called X" will keep mis-transcribing
 * X at the moment of spawning. One message either way puts the name in the set
 * at the next connect.
 */
export function agentKeytermNames(agents, events = [], humanId = null, limit = KEYTERM_AGENT_LIMIT) {
  const roster = (agents || []).filter((a) => !a?.dead && !a?.human && agentName(a))
  const byId = new Map(roster.map((a) => [a.id, a]))
  const byName = new Map(roster.map((a) => [agentName(a).toLowerCase(), a]))

  const chosen = []
  const seen = new Set()
  const add = (agent) => {
    if (!agent || seen.has(agent.id) || chosen.length >= limit) return
    seen.add(agent.id)
    chosen.push(agent)
  }

  for (const agent of conversationPartners(events, humanId, byId, byName)) add(agent)

  // Floor: most recently active agents fill whatever remains, so the set is
  // never empty at session start.
  if (chosen.length < limit) {
    const byRecency = [...roster].sort((a, b) => lastActive(b) - lastActive(a))
    for (const agent of byRecency) add(agent)
  }

  const candidates = []
  for (const agent of chosen) {
    const name = spokenForm(agentName(agent))
    candidates.push(name)
    const parts = name.split(' ')
    if (parts.length < 2) continue
    for (const part of parts) {
      if (part.length >= 3 && !/^\d+$/.test(part)) candidates.push(part)
    }
  }
  return candidates
}
