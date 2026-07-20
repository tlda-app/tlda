// Live end-to-end driver for the turn-end INTROSPECTION POKE bot against the
// sandbox. Run AFTER: tlda-dev serve --sandbox --port 5280 is up, AND disposition-bot
// running pointed at TLDA_SERVER=https://localhost:5280 with a SHORT countdown
// (DISPO_COUNTDOWN_SEC=2) so the test is quick.
//
// Injects real turns over /ws/fleet and checks the bot's live behavior:
//   1. turn ends, no Skip message             → bot SHOULD poke (countdown expired)
//   2. turn ends, Skip messages that agent    → bot SHOULD STILL poke
//   3. manual kick ("poke <agent>" to bot)    → bot SHOULD poke immediately
// Verifies via the sandbox events DB: turn_ended persisted, and a chat from
// fleet:disposition to both agents.
import WebSocket from 'ws'
import https from 'https'

const BASE = process.env.SBX || 'https://localhost:5280'
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws/fleet'
const DAEMON_WS_URL = BASE.replace(/^http/, 'ws') + '/ws/fleet-daemon'
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
let daemonWs
let mid = 1
const send = m => ws.send(JSON.stringify({ id: mid++, ...m }))
const sendActivity = (agent_id, tool = 'Edit') => daemonWs.send(JSON.stringify({
  type: 'activity-event', agent_id, tool, arg: 'sandbox-live', input: {}, ts: new Date().toISOString(),
}))

const RUN = process.pid
const POKE = `fleet:sbx-poke-${RUN}`   // turn ends, no Skip message → should be poked
const PRESENT = `fleet:sbx-present-${RUN}` // turn ends, Skip messages → should still be poked
const KICK = `fleet:sbx-kick-${RUN}`   // manual kick target

await new Promise((resolve) => ws.on('open', resolve))
daemonWs = new WebSocket(DAEMON_WS_URL)
await new Promise((resolve) => daemonWs.on('open', resolve))
daemonWs.send(JSON.stringify({
  type: 'daemon-hello', machine_id: `sandbox-live-${process.pid}`, env_name: 'sandbox-live',
  boot_id: Date.now(), user: 'sandbox-live', hostname: 'sandbox-live', version: 'test',
}))
await sleep(200)

// Register the three workers.
for (const id of [POKE, PRESENT, KICK]) {
  send({ type: 'reserve-shell', id, name: id.replace('fleet:', ''), labels: ['worker'] })
  await sleep(150)
  send({ type: 'login', agent_id: id, labels: ['worker'] })
  await sleep(150)
}

// Give both agents owed work. Case 1 is addressed by another agent; case 2 by
// Skip himself, which must not suppress the later private continuation check.
send({ type: 'chat', from: 'fleet:sandbox-manager', to: POKE, message: 'please handle this' })
send({ type: 'chat', from: SKIP, to: PRESENT, message: 'please handle this' })
await sleep(200)

// Case 1 + 2: both do substantive work and end a turn.
for (const id of [POKE, PRESENT]) {
  send({ type: 'agent-thinking', agentId: id, thinking: true })
  await sleep(150)
  sendActivity(id)
  await sleep(150)
  send({ type: 'agent-thinking', agentId: id, thinking: false })
  await sleep(150)
}
// Case 2: Skip messages the PRESENT agent before its countdown expires. This
// must not turn Skip into the continuation mechanism or cancel the private poke.
send({ type: 'chat', from: SKIP, to: PRESENT, message: 'hey, hold on' })

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
ok(teAgents.has(PRESENT), `turn_ended persisted for ${PRESENT}`)

async function pokedBy(agent) {
  const evs = (await getJson(`/api/store/events?agent=${encodeURIComponent(agent)}&limit=200`))?.events || []
  return evs.some(e => e.type === 'chat' && e.from === DISPO && e.to === agent)
}

ok(await pokedBy(POKE), `${POKE}: poked after countdown (no Skip message)`)
ok(await pokedBy(PRESENT), `${PRESENT}: poked even though Skip messaged it`)
ok(await pokedBy(KICK), `${KICK}: poked immediately by manual kick`)

// Show the actual poke text once.
const pe = (await getJson(`/api/store/events?agent=${encodeURIComponent(POKE)}&limit=200`))?.events || []
const m = pe.find(e => e.type === 'chat' && e.from === DISPO && e.to === POKE)
if (m) console.log(`        > poke text: ${(m.text || '').split('\n')[0].slice(0, 90)}`)

ws.close()
daemonWs.close()
console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
