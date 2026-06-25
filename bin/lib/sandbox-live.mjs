// Live end-to-end driver for the turn-end INTROSPECTION POKE bot against the
// sandbox. Run AFTER: tlda-dev sandbox backend up on :5280, AND disposition-bot
// running pointed at TLDA_SERVER=https://localhost:5280 with a SHORT countdown
// (DISPO_COUNTDOWN_SEC=2) so the test is quick.
//
// Injects real turns over /ws/fleet and checks the bot's live behavior:
//   1. turn ends, no Skip message            → bot SHOULD poke (countdown expired)
//   2. turn ends, Skip messages that agent    → bot SHOULD stay quiet (cancelled)
//   3. manual kick ("poke <agent>" to bot)    → bot SHOULD poke immediately
// Verifies via the sandbox events DB: turn_ended persisted, and a chat from
// fleet:disposition to the right agents (and NOT to the cancelled one).
import WebSocket from 'ws'
import https from 'https'

const BASE = process.env.SBX || 'https://localhost:5280'
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws/fleet'
const SKIP = 'fleet:skip'
const DISPO = 'fleet:disposition'
// Match the bot's countdown (DISPO_COUNTDOWN_SEC); default 2s for the rig.
const COUNTDOWN_MS = (parseInt(process.env.DISPO_COUNTDOWN_SEC || '', 10) || 2) * 1000
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

const POKE = 'fleet:sbx-poke'   // turn ends, no Skip message → should be poked
const CANCEL = 'fleet:sbx-cancel' // turn ends, Skip messages → should NOT be poked
const KICK = 'fleet:sbx-kick'   // manual kick target

await new Promise((resolve) => ws.on('open', resolve))

// Register the three workers.
for (const id of [POKE, CANCEL, KICK]) {
  send({ type: 'register', id, name: id.replace('fleet:', ''), human: false, labels: ['worker'] })
  await sleep(150)
}

// Case 1 + 2: both end a turn (thinking true → false = turn_ended).
for (const id of [POKE, CANCEL]) {
  send({ type: 'agent-thinking', agentId: id, thinking: true })
  await sleep(150)
  send({ type: 'agent-thinking', agentId: id, thinking: false })
  await sleep(150)
}
// Case 2: Skip messages the CANCEL agent before its countdown expires → cancel.
send({ type: 'chat', from: SKIP, to: CANCEL, message: 'hey, hold on' })

// Case 3: manual kick — Skip tells the bot to poke the KICK agent.
await sleep(150)
send({ type: 'chat', from: SKIP, to: DISPO, message: `poke ${KICK}` })

// Wait out the countdown + processing.
await sleep(COUNTDOWN_MS + 2500)

let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log(`PASS  ${name}`) } else { fail++; console.log(`FAIL  ${name}`) } }

// turn_ended persisted for the two that ended a turn.
const te = (await getJson('/api/store/events?type=turn_ended&limit=200'))?.events || []
const teAgents = new Set(te.map(e => e.agent_id || e.from))
ok(teAgents.has(POKE), `turn_ended persisted for ${POKE}`)
ok(teAgents.has(CANCEL), `turn_ended persisted for ${CANCEL}`)

async function pokedBy(agent) {
  const evs = (await getJson(`/api/store/events?agent=${encodeURIComponent(agent)}&limit=200`))?.events || []
  return evs.some(e => e.type === 'chat' && e.from === DISPO && e.to === agent)
}

ok(await pokedBy(POKE), `${POKE}: poked after countdown (no Skip message)`)
ok(!(await pokedBy(CANCEL)), `${CANCEL}: NOT poked (Skip messaged it → cancelled)`)
ok(await pokedBy(KICK), `${KICK}: poked immediately by manual kick`)

// Show the actual poke text once.
const pe = (await getJson(`/api/store/events?agent=${encodeURIComponent(POKE)}&limit=200`))?.events || []
const m = pe.find(e => e.type === 'chat' && e.from === DISPO && e.to === POKE)
if (m) console.log(`        > poke text: ${(m.text || '').split('\n')[0].slice(0, 90)}`)

ws.close()
console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
