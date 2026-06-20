// Live end-to-end driver for the turn-end self-check bot against the sandbox.
// Run AFTER: tlda-dev sandbox backend up on :5280, AND disposition-bot running
// pointed at TLDA_SERVER=https://localhost:5280.
//
// Injects three real turns over /ws/fleet and checks the bot's live behavior:
//   1. done-claim, no verification activity → bot SHOULD fire (untouched-surface)
//   2. plain finding (no claim, no punt)     → bot should stay QUIET
//   3. directive punt ("reload and check")   → bot SHOULD fire (dont-make-him-steer)
// Verifies via the sandbox events DB: turn_ended persisted for each, and a chat
// from fleet:disposition only to the two failure turns, not the quiet one.
// (The done-WITH-verification "stays quiet" branch is covered by the unit test;
//  activity events arrive on the daemon path, not the /ws/fleet path this rig uses.)
import WebSocket from 'ws'
import https from 'https'

const BASE = process.env.SBX || 'https://localhost:5280'
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws/fleet'
const SKIP = 'fleet:skip'
const DISPO = 'fleet:disposition'
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const sleep = ms => new Promise(r => setTimeout(r, ms))
function getJson(p) {
  return new Promise((resolve) => {
    https.get(`${BASE}${p}`, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)) } catch { resolve(null) } }) })
      .on('error', () => resolve(null))
  })
}

const ws = new WebSocket(WS_URL)
let mid = 1
const send = m => ws.send(JSON.stringify({ id: mid++, ...m }))

const CASES = [
  { id: 'fleet:sbx-pos',   msg: 'Fixed the build-card color — the sidebar is 50/50 now. Done.', expectFire: true,  label: 'untouched-surface' },
  { id: 'fleet:sbx-quiet', msg: 'Found the root cause: the daemon emits agent-thinking every sweep, not on transition.', expectFire: false },
  { id: 'fleet:sbx-punt',  msg: 'Pushed the change — reload and check it looks right on your end.', expectFire: true,  label: 'dont-make-him-steer' },
]

await new Promise((resolve) => ws.on('open', resolve))

for (const c of CASES) {
  send({ type: 'register', id: c.id, name: c.id.replace('fleet:', ''), human: false, labels: ['worker'] })
  await sleep(150)
  // The agent's report TO Skip (what it claimed)
  send({ type: 'chat', from: c.id, to: SKIP, message: c.msg })
  await sleep(150)
  // The turn: thinking true → false (= turn_ended)
  send({ type: 'agent-thinking', agentId: c.id, thinking: true })
  await sleep(200)
  send({ type: 'agent-thinking', agentId: c.id, thinking: false })
  await sleep(400)
}

// Wait out the bot's SETTLE_MS (1.5s) + processing
await sleep(4000)

let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log(`PASS  ${name}`) } else { fail++; console.log(`FAIL  ${name}`) } }

// turn_ended persisted + broadcast for all three real agents
const te = (await getJson('/api/store/events?type=turn_ended&limit=200'))?.events || []
const teAgents = new Set(te.map(e => e.agent_id || e.from))
for (const c of CASES) ok(teAgents.has(c.id), `turn_ended persisted for ${c.id}`)

// The bot's behavior: a chat from fleet:disposition to the agent = it fired.
for (const c of CASES) {
  const evs = (await getJson(`/api/store/events?agent=${encodeURIComponent(c.id)}&limit=200`))?.events || []
  const fired = evs.some(e => e.type === 'chat' && e.from === DISPO && e.to === c.id)
  ok(fired === c.expectFire, `${c.id}: bot ${c.expectFire ? 'FIRED' : 'stayed QUIET'} as expected (live=${fired ? 'fired' : 'quiet'})`)
  if (fired) {
    const m = evs.find(e => e.type === 'chat' && e.from === DISPO && e.to === c.id)
    console.log(`        > self-check text: ${(m.text || '').split('\n')[0].slice(0, 90)}`)
  }
}

ws.close()
console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
