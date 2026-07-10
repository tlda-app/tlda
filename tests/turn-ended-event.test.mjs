// Run: node tests/turn-ended-event.test.mjs
// Integration test of the turn_ended event MECHANISM the bot relies on:
//   share({type:'turn_ended'}) → (a) fires the onEvent listener that the server
//   turns into a fleet-event broadcast, and (b) persists a row queryable by the
//   bot via the same query the /api/store/events endpoint uses.
// Also checks the thinking→idle EDGE dedup logic (only the true→false edge emits).
import os from 'os'
import path from 'path'
import fs from 'fs'
import { FleetStore } from '../server/lib/fleet-store.mjs'

const dbPath = path.join(os.tmpdir(), `turn-ended-test-${process.pid}.db`)
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.unlinkSync(f) } catch {} }

const store = new FleetStore(dbPath)
const AGENT = 'fleet:test-worker'
store.upsertAgent({ id: AGENT, friendly_name: 'test-worker', human: false, status: 'awake' })

// Mirror server/unified-server.mjs: fleetStore.onEvent → broadcastEvent('fleet-event', e)
const broadcasts = []
store.onEvent(e => broadcasts.push(e))

// Mirror emitTurnEnded's share() call + the _thinkingState edge dedup.
const _thinkingState = new Map()
async function onThinking(agentId, thinking) {
  if (thinking) { _thinkingState.set(agentId, Date.now()); return }
  const startedAt = _thinkingState.get(agentId)
  _thinkingState.delete(agentId)
  if (startedAt === undefined) return // no prior 'thinking' → not a turn edge
  const a = store.getAgent?.(agentId)
  if (a?.human) return
  await store.share({
    type: 'turn_ended', from: agentId, agentId, text: null,
    metadata: { kind: 'turn-end', startedAt: new Date(startedAt).toISOString(), endedAt: new Date().toISOString() },
    unread: false,
  })
}

let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log(`PASS  ${name}`) } else { fail++; console.log(`FAIL  ${name}`) } }

// 1. A real turn edge: thinking true → false emits exactly one turn_ended.
await onThinking(AGENT, true)
await onThinking(AGENT, false)
const turnEvents = broadcasts.filter(e => e.type === 'turn_ended')
ok(turnEvents.length === 1, 'true->false edge broadcast exactly one turn_ended')
ok(turnEvents[0]?.agent_id === AGENT, 'broadcast carries agent_id')

// 2. Dedup: a second 'false' with no intervening 'true' must NOT emit.
await onThinking(AGENT, false)
ok(broadcasts.filter(e => e.type === 'turn_ended').length === 1, 'spurious idle (no prior thinking) does not re-emit')

// 3. Persistence: the row is queryable exactly as the bot reads it.
const rows = store.queryAgentEvents({ agent: AGENT, limit: 50 }).filter(e => e.type === 'turn_ended')
ok(rows.length === 1, 'turn_ended row persisted + queryable via queryAgentEvents')

// 4. Human/bot agents do not get turns.
store.upsertAgent({ id: 'fleet:skip', friendly_name: 'skip', human: true, status: 'awake' })
await onThinking('fleet:skip', true)
await onThinking('fleet:skip', false)
ok(broadcasts.filter(e => e.type === 'turn_ended' && e.agent_id === 'fleet:skip').length === 0, 'human agent emits no turn_ended')

store.close?.()
for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.unlinkSync(f) } catch {} }
console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
