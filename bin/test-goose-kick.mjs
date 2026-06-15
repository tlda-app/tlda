// Table-driven unit tests for the pure goose status + kick logic.
// Run: node bin/test-goose-kick.mjs
import {
  decideKick, newKickState, GOOSE_KICK_CAP,
  gooseStatus, liveTail, resolveGooseStatus, GOOSE_STUCK_MS,
} from './lib/goose-kick.mjs'

// Real captured goose pane tails (from minimax3, 2026-06-14).
const IDLE = [
  '  ━━━━ 13% 17k/128k',
  '🪿 Enter to send · Ctrl+J newline',
].join('\n')
const WORKING = [
  '◐  Processing user intent…  (Ctrl+C to interrupt)',
  '  ⏱ 1m 02s',
  '  ━━━━ 39% 50k/128k',
  '🪿 📬 Message from teacher: review the draft',
].join('\n')
const COMPACTING = [
  'Exceeded auto-compact threshold… Performing auto-compaction…',
  '◓  goose is compacting the conversation…',
].join('\n')
// Frozen/stuck: a stale glyph above a queued-but-unprocessed prompt line — NO
// `Enter to send` (input isn't empty), so idle-override alone misses it.
const STUCK = [
  '◐  Processing user intent…  (Ctrl+C to interrupt)',
  '  ⏱ 2m 30s',
  '  ━━━━ 39% 50k/128k',
  '🪿 Continue — your assignment is not finished. …',
].join('\n')
const BOOT = ['', '  some transient boot frame', ''].join('\n')

let pass = 0, fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}`) }
}

console.log('gooseStatus (instantaneous):')
check('idle prompt → idle', gooseStatus(IDLE) === 'idle')
check('working line → working', gooseStatus(WORKING) === 'working')
check('compacting line → compacting', gooseStatus(COMPACTING) === 'compacting')
check('stale glyph + queued prompt → working (pre-liveness)', gooseStatus(STUCK) === 'working')
check('no glyph / no prompt → unknown', gooseStatus(BOOT) === 'unknown')
// Scrollback `Enter to send` above a live working line must NOT read idle.
check('scrollback Enter-to-send + live work → working',
  gooseStatus(['🪿 Enter to send · Ctrl+J newline', '◐  Taming tensors…  (Ctrl+C to interrupt)', '🪿 📬 Message from teacher: …'].join('\n')) === 'working')

console.log('liveTail (fingerprint):')
check('drops the ⏱ line', !/⏱/.test(liveTail(WORKING)))
check('keeps the verb-phrase', /Processing user intent/.test(liveTail(WORKING)))
check('keeps the context bar', /50k\/128k/.test(liveTail(WORKING)))

console.log('resolveGooseStatus (liveness):')
// idle / unknown clear the tracker
check('idle → idle, no tracker', (() => { const r = resolveGooseStatus(IDLE, { fingerprint: 'x', since: 0 }, 0); return r.status === 'idle' && r.live === null })())
check('unknown → unknown, no tracker', resolveGooseStatus(BOOT, null, 0).live === null)

// TRUE positive: byte-identical live tail for ≥ GOOSE_STUCK_MS → stuck.
{
  let live = null, t = 0, last
  for (; t <= GOOSE_STUCK_MS; t += 30_000) { const r = resolveGooseStatus(STUCK, live, t); live = r.live; last = r }
  check(`frozen tail ≥${GOOSE_STUCK_MS}ms → stuck`, last.status === 'stuck')
  // just before the threshold it must still be working, not stuck
  const early = resolveGooseStatus(STUCK, { fingerprint: liveTail(STUCK), since: 0 }, GOOSE_STUCK_MS - 1)
  check('frozen tail just under threshold → working (not stuck)', early.status === 'working')
}

// FALSE positive guard (ops-mandated): a busy agent mid-long-generation, whose
// verb-phrase / context bar advance every sweep, must NEVER read stuck even though
// many sweeps elapse far past the threshold.
{
  const frames = [
    '◐  Processing user intent…  (Ctrl+C to interrupt)\n  ⏱ 0m 30s\n  ━━━━ 39% 50k/128k\n🪿 📬 Message from teacher: …',
    '◑  Processing user intent…  (Ctrl+C to interrupt)\n  ⏱ 1m 00s\n  ━━━━ 41% 53k/128k\n🪿 📬 Message from teacher: …',
    '◒  Taming tensors…  (Ctrl+C to interrupt)\n  ⏱ 1m 30s\n  ━━━━ 44% 57k/128k\n🪿 📬 Message from teacher: …',
    '◓  Taming tensors…  (Ctrl+C to interrupt)\n  ⏱ 2m 00s\n  ━━━━ 47% 61k/128k\n🪿 📬 Message from teacher: …',
    '◐  Folding gradients…  (Ctrl+C to interrupt)\n  ⏱ 2m 30s\n  ━━━━ 50% 64k/128k\n🪿 📬 Message from teacher: …',
  ]
  let live = null, everStuck = false
  frames.forEach((f, i) => { const r = resolveGooseStatus(f, live, i * 30_000); live = r.live; if (r.status === 'stuck') everStuck = true })
  check('busy agent mid-long-generation NEVER reads stuck', everStuck === false)
}
// Edge: same verb-phrase + glyph but the context bar (token count) advances → live.
{
  const a = '◐  Processing user intent…  (Ctrl+C to interrupt)\n  ━━━━ 39% 50k/128k\n🪿 📬 …'
  const b = '◐  Processing user intent…  (Ctrl+C to interrupt)\n  ━━━━ 41% 53k/128k\n🪿 📬 …'
  let live = resolveGooseStatus(a, null, 0).live
  const r = resolveGooseStatus(b, live, GOOSE_STUCK_MS + 1)
  check('token-count advance resets freeze clock → working', r.status === 'working')
}

console.log('decideKick (drives on resolved status):')
// 1. working pane → never kick, clears a stale no-progress run
{
  const r = decideKick('working', { lastInboundId: 5, chatAfterInbound: false, lastToolReqId: 9 }, { lastInboundId: 5, deadKicks: 3, lastKickToolReqId: 9 })
  check('working → no kick', r.kick === false && r.reason === 'working')
  check('working → resets deadKicks', r.state.deadKicks === 0)
}
// 1b. compacting → never kick, also resets no-progress run
{
  const r = decideKick('compacting', { lastInboundId: 5, chatAfterInbound: false, lastToolReqId: 9 }, { lastInboundId: 5, deadKicks: 2, lastKickToolReqId: 9 })
  check('compacting → no kick', r.kick === false && r.reason === 'compacting')
  check('compacting → resets deadKicks', r.state.deadKicks === 0)
}
// 1c. unknown (boot/transition) → never kick, does NOT reset deadKicks
{
  const r = decideKick('unknown', { lastInboundId: 5, chatAfterInbound: false, lastToolReqId: 9 }, { lastInboundId: 5, deadKicks: 2, lastKickToolReqId: 9 })
  check('unknown → no kick', r.kick === false && r.reason === 'unknown')
  check('unknown → leaves deadKicks alone', r.state.deadKicks === 2)
}
// 2. idle, no sqlite info → never kick
{
  const r = decideKick('idle', null, newKickState())
  check('idle + no info → no kick', r.kick === false && r.reason === 'nothing-owed')
}
// 3. idle, nothing owed (no inbound) → never kick (boot/no-task case)
{
  const r = decideKick('idle', { lastInboundId: 0, chatAfterInbound: false, lastToolReqId: 0 }, newKickState())
  check('idle + nothing owed → no kick', r.kick === false && r.reason === 'nothing-owed')
}
// 4. idle, delivered (chat after inbound) → never kick
{
  const r = decideKick('idle', { lastInboundId: 10, chatAfterInbound: true, lastToolReqId: 12 }, { lastInboundId: 10, deadKicks: 2, lastKickToolReqId: 11 })
  check('idle + delivered → no kick', r.kick === false && r.reason === 'delivered')
  check('delivered → resets deadKicks', r.state.deadKicks === 0)
}
// 5. idle, stalled, first kick → kick with the 'nudge' (Continue text) action
let s = newKickState()
{
  const r = decideKick('idle', { lastInboundId: 10, chatAfterInbound: false, lastToolReqId: 12 }, s)
  check('first stall → kick', r.kick === true && r.reason === 'kick')
  check('idle stall → nudge action', r.action === 'nudge')
  check('first kick → deadKicks 0', r.state.deadKicks === 0)
  check('first kick → records toolReqId', r.state.lastKickToolReqId === 12)
  s = r.state
}
// 6. still stalled, NO progress (toolReqId unchanged) → kick, deadKicks climbs
{
  const r = decideKick('idle', { lastInboundId: 10, chatAfterInbound: false, lastToolReqId: 12 }, s)
  check('no-progress stall → kick', r.kick === true)
  check('no-progress → deadKicks 1', r.state.deadKicks === 1)
  s = r.state
}
// 7. keep stalling with no progress until the cap, then stop
{
  for (let i = 0; i < 10 && s.deadKicks < GOOSE_KICK_CAP; i++) {
    const r = decideKick('idle', { lastInboundId: 10, chatAfterInbound: false, lastToolReqId: 12 }, s)
    s = r.state
  }
  check(`reaches cap (deadKicks=${s.deadKicks})`, s.deadKicks === GOOSE_KICK_CAP)
  const r = decideKick('idle', { lastInboundId: 10, chatAfterInbound: false, lastToolReqId: 12 }, s)
  check('at cap → no kick (capped)', r.kick === false && r.reason === 'capped')
}
// 8. progress (toolReqId advanced) resets the cap — long multi-step never cut off
{
  let s2 = { lastInboundId: 10, deadKicks: GOOSE_KICK_CAP - 1, lastKickToolReqId: 12 }
  const r = decideKick('idle', { lastInboundId: 10, chatAfterInbound: false, lastToolReqId: 20 }, s2)
  check('progress → kick (after-progress)', r.kick === true && r.reason === 'kick-after-progress')
  check('progress → deadKicks reset to 0', r.state.deadKicks === 0)
  check('progress → toolReqId advanced', r.state.lastKickToolReqId === 20)
}
// 9. a fresh inbound resets the whole kick state
{
  let s3 = { lastInboundId: 10, deadKicks: GOOSE_KICK_CAP, lastKickToolReqId: 12 }
  const r = decideKick('idle', { lastInboundId: 30, chatAfterInbound: false, lastToolReqId: 31 }, s3)
  check('new inbound → kick again', r.kick === true)
  check('new inbound → deadKicks reset', r.state.deadKicks === 0)
  check('new inbound → lastInboundId advanced', r.state.lastInboundId === 30)
}
// 10. STUCK (frozen) with undelivered work → kick with the bare-'enter' action,
//     NOT the nudge — the recovery is to flush the already-queued input.
{
  const r = decideKick('stuck', { lastInboundId: 10, chatAfterInbound: false, lastToolReqId: 12 }, newKickState())
  check('stuck + owed → kick', r.kick === true)
  check('stuck → enter action (bare Enter, not Continue text)', r.action === 'enter')
}
// 11. stuck but already delivered → no kick (don't Enter a done agent)
{
  const r = decideKick('stuck', { lastInboundId: 10, chatAfterInbound: true, lastToolReqId: 12 }, { lastInboundId: 10, deadKicks: 0, lastKickToolReqId: null })
  check('stuck + delivered → no kick', r.kick === false && r.reason === 'delivered')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
