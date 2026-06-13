// Table-driven unit test for the pure decideKick branch logic.
// Run: node bin/test-goose-kick.mjs
import { decideKick, newKickState, GOOSE_KICK_CAP } from './lib/goose-kick.mjs'

const IDLE = '🪿 Enter to send · Ctrl+J newline'
const WORKING = '◒  Illuminating input insights...  (Ctrl+C to interrupt)'
let pass = 0, fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}`) }
}

// 1. working pane → never kick, clears a stale no-progress run
{
  const r = decideKick(WORKING, { lastInboundId: 5, chatAfterInbound: false, lastToolReqId: 9 }, { lastInboundId: 5, deadKicks: 3, lastKickToolReqId: 9 })
  check('working → no kick', r.kick === false && r.reason === 'working')
  check('working → resets deadKicks', r.state.deadKicks === 0)
}
// 2. idle, no sqlite info → never kick
{
  const r = decideKick(IDLE, null, newKickState())
  check('idle + no info → no kick', r.kick === false && r.reason === 'nothing-owed')
}
// 3. idle, nothing owed (no inbound) → never kick (boot/no-task case)
{
  const r = decideKick(IDLE, { lastInboundId: 0, chatAfterInbound: false, lastToolReqId: 0 }, newKickState())
  check('idle + nothing owed → no kick', r.kick === false && r.reason === 'nothing-owed')
}
// 4. idle, delivered (chat after inbound) → never kick
{
  const r = decideKick(IDLE, { lastInboundId: 10, chatAfterInbound: true, lastToolReqId: 12 }, { lastInboundId: 10, deadKicks: 2, lastKickToolReqId: 11 })
  check('idle + delivered → no kick', r.kick === false && r.reason === 'delivered')
  check('delivered → resets deadKicks', r.state.deadKicks === 0)
}
// 5. idle, stalled, first kick → kick, deadKicks stays 0 (first is free)
let s = newKickState()
{
  const r = decideKick(IDLE, { lastInboundId: 10, chatAfterInbound: false, lastToolReqId: 12 }, s)
  check('first stall → kick', r.kick === true && r.reason === 'kick')
  check('first kick → deadKicks 0', r.state.deadKicks === 0)
  check('first kick → records toolReqId', r.state.lastKickToolReqId === 12)
  s = r.state
}
// 6. still stalled, NO progress (toolReqId unchanged) → kick, deadKicks climbs
{
  const r = decideKick(IDLE, { lastInboundId: 10, chatAfterInbound: false, lastToolReqId: 12 }, s)
  check('no-progress stall → kick', r.kick === true)
  check('no-progress → deadKicks 1', r.state.deadKicks === 1)
  s = r.state
}
// 7. keep stalling with no progress until the cap, then stop
{
  for (let i = 0; i < 10 && s.deadKicks < GOOSE_KICK_CAP; i++) {
    const r = decideKick(IDLE, { lastInboundId: 10, chatAfterInbound: false, lastToolReqId: 12 }, s)
    s = r.state
  }
  check(`reaches cap (deadKicks=${s.deadKicks})`, s.deadKicks === GOOSE_KICK_CAP)
  const r = decideKick(IDLE, { lastInboundId: 10, chatAfterInbound: false, lastToolReqId: 12 }, s)
  check('at cap → no kick (capped)', r.kick === false && r.reason === 'capped')
}
// 8. progress (toolReqId advanced) resets the cap — long multi-step never cut off
{
  let s2 = { lastInboundId: 10, deadKicks: GOOSE_KICK_CAP - 1, lastKickToolReqId: 12 }
  const r = decideKick(IDLE, { lastInboundId: 10, chatAfterInbound: false, lastToolReqId: 20 }, s2)
  check('progress → kick (after-progress)', r.kick === true && r.reason === 'kick-after-progress')
  check('progress → deadKicks reset to 0', r.state.deadKicks === 0)
  check('progress → toolReqId advanced', r.state.lastKickToolReqId === 20)
}
// 9. a fresh inbound resets the whole kick state
{
  let s3 = { lastInboundId: 10, deadKicks: GOOSE_KICK_CAP, lastKickToolReqId: 12 }
  const r = decideKick(IDLE, { lastInboundId: 30, chatAfterInbound: false, lastToolReqId: 31 }, s3)
  check('new inbound → kick again', r.kick === true)
  check('new inbound → deadKicks reset', r.state.deadKicks === 0)
  check('new inbound → lastInboundId advanced', r.state.lastInboundId === 30)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
