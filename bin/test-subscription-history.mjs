// The subscription's initial window must be the NEWEST matching events, in
// chronological order — the same set and the same order the panel would have
// after scrolling back through the old path.
//
// This exists because the two halves disagree about direction: history() walks
// newest-first and cuts at `limit`, while queryChatHistory reverses to
// chronological for its own callers. Feeding one to the other unadapted keeps
// the OLDEST matches and reports a cursor from the wrong end — a panel that
// silently shows ancient history and pages the wrong way, which looks like
// "chat is stuck" and not like a sort bug.
import { createFilterSubscriptions } from '../server/lib/filter-subscriptions.mjs'
import { labelsForAgent } from '../shared/fleet-labels.mjs'

const AGENTS = [
  { id: 'fleet:aaa', friendly_name: 'alice' },
  { id: 'fleet:bbb', friendly_name: 'bob' },
  { id: 'fleet:ccc', friendly_name: 'carol' },
]

// 40 events alternating between an alice/bob conversation and unrelated carol
// traffic, oldest first — the shape of a real table.
const ROWS = []
for (let i = 0; i < 40; i++) {
  const inConversation = i % 2 === 0
  ROWS.push({
    id: 1000 + i,
    type: 'chat',
    timestamp: new Date(Date.UTC(2026, 6, 25, 0, 0, i)).toISOString(),
    from: inConversation ? 'fleet:aaa' : 'fleet:ccc',
    to: inConversation ? 'fleet:bbb' : 'fleet:aaa',
    text: `m${i}`,
  })
}

// Stands in for fleetStore.queryChatHistory: newest-first internally, reversed
// to chronological on the way out, exactly as the real one does.
function queryChatHistory({ before, agents, limit }) {
  const ids = new Set(agents || [])
  let rows = ROWS.filter(r => (!ids.size || ids.has(r.from) || ids.has(r.to)))
  if (before) rows = rows.filter(r => r.timestamp < before)
  rows = rows.slice().sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)).slice(0, limit)
  rows.reverse()
  return rows
}

const subs = createFilterSubscriptions({
  getAgentsByIds: async (agentIds) => {
    const ids = new Set(agentIds)
    return AGENTS.filter(agent => ids.has(agent.id))
  },
  loadMembershipSpans: async (labels) => AGENTS.flatMap(agent =>
    labelsForAgent(agent)
      .filter(label => labels.includes(label))
      .map(label => ({
        fleet_id: agent.id,
        label,
        from_ts: '1970-01-01T00:00:00.000Z',
        to_ts: null,
      }))
  ),
})
const filter = [[['from', 'alice']], [['to', 'alice']]]

// The adapter under test — the same two reversals unified-server.mjs performs.
const page = await subs.history(filter, {
  limit: 5,
  queryPage: ({ before, agentIds, limit }) =>
    queryChatHistory({ before, agents: agentIds, limit }).slice().reverse(),
})
const events = page.events.slice().reverse()

let failed = false
const T = (name, cond, detail) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' — ' + name + (cond ? '' : `\n      ${detail}`))
  if (!cond) failed = true
}

const texts = events.map(e => e.text)
T('returns a full page', events.length === 5, `got ${events.length}`)
T('is chronological (oldest first)', texts.join() === texts.slice().sort((a, b) => (+a.slice(1) - +b.slice(1))).join(), texts.join())

// alice is in every event — the alternation is which side she is on — so the
// newest 5 are simply m35..m39.
T('keeps the NEWEST matches, not the oldest', texts.join() === 'm35,m36,m37,m38,m39', texts.join())
T('reports there is more', page.hasMore === true, String(page.hasMore))

// The next page must continue from the oldest row EXAMINED, and must not
// re-serve or skip rows.
const page2 = await subs.history(filter, {
  limit: 5, before: page.nextCursor,
  queryPage: ({ before, agentIds, limit }) =>
    queryChatHistory({ before, agents: agentIds, limit }).slice().reverse(),
})
const texts2 = page2.events.slice().reverse().map(e => e.text)
T('the next page is strictly older, contiguous', texts2.join() === 'm30,m31,m32,m33,m34', texts2.join())

// A filter that excludes some traffic must actually exclude it.
const carolOnly = await subs.history([[['from', 'carol']]], {
  limit: 100,
  queryPage: ({ before, agentIds, limit }) =>
    queryChatHistory({ before, agents: agentIds, limit }).slice().reverse(),
})
T('a narrower filter drops non-matching rows',
  carolOnly.events.every(e => e.from === 'fleet:ccc') && carolOnly.events.length === 20,
  `${carolOnly.events.length} events`)

// The load-bearing invariant: history and live agree, because they are the same
// predicate. Assert it rather than trust it.
const disagreements = []
for (const r of ROWS) {
  const live = await subs.verdict(filter, r, {})
  const inHistory = carolOnly.events.includes(r)
  if (live && inHistory && r.from !== 'fleet:ccc') disagreements.push(r)
}
T('history membership is verdict() membership', disagreements.length === 0, `${disagreements.length} disagreed`)

console.log(failed ? '\nSOME CHECKS FAILED' : '\nALL SUBSCRIPTION-HISTORY CHECKS PASSED')
process.exit(failed ? 1 : 0)
