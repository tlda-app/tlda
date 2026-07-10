// Table-driven unit tests for the pure goose status + kick logic.
// Run: node tests/goose-kick.test.mjs
import {
  decideKick, newKickState, GOOSE_KICK_CAP,
  gooseStatus, liveTail, resolveGooseStatus, GOOSE_STUCK_MS,
} from '../agent-runtime/goose-kick.mjs'

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
// Pending: a queued message sits unsubmitted at the `🪿` prompt with NO spinner —
// goose received it but never started processing (mistral2 sat here 9 min). NOT
// `Enter to send` (input isn't empty), NO glyph → the most common between-turns wedge.
const PENDING = [
  '  some earlier output line',
  '🪿 📬 Message from teacher: We aren\'t doing regression here… · Call my_task()…',
].join('\n')
const DEEPSEEK_THINKING_NO_GLYPH = [
  '  ▸ get_thread tlda',
  '    agent: todd',
  '    since: 10m',
  '',
  '  ⏱ 1m 11s',
  '  ━━━━━━━━━╌╌╌╌╌╌╌╌╌╌╌ 44% 57k/128k',
  '🪿 📬 Message from d2eed6ff: New candidate to attack, prompted by Skip\'s anti-concentration point: · Use anti-concentrat',
  'ion directly on the fitted sco… · (TRUNCATED — showing 120/1151 chars. You MUST call my_task() for the full text before',
  'responding) · Call my_task() to read and respond.',
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
check('🪿 queued msg, no glyph → pending', gooseStatus(PENDING) === 'pending')
check('DeepSeek thinking progress with no glyph → working', gooseStatus(DEEPSEEK_THINKING_NO_GLYPH) === 'working')
check('no 🪿 prompt at all → unknown (boot)', gooseStatus(BOOT) === 'unknown')
// A `🪿 📬` prompt WITH a live spinner above is working, NOT pending.
check('🪿 📬 + spinner above → working (not pending)',
  gooseStatus(['◐  Taming tensors…  (Ctrl+C to interrupt)', '🪿 📬 Message from teacher: …'].join('\n')) === 'working')
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

console.log('decideKick (progress == delivered chat):')
// 1. working pane → never kick, clears a stale no-progress run
{
  const r = decideKick('working', { lastInboundId: 5, chatAfterInbound: false }, { lastInboundId: 5, deadKicks: 3, kicked: true })
  check('working → no kick', r.kick === false && r.reason === 'working')
  check('working → resets deadKicks', r.state.deadKicks === 0)
}
// 1b. compacting → never kick, also resets no-progress run
{
  const r = decideKick('compacting', { lastInboundId: 5, chatAfterInbound: false }, { lastInboundId: 5, deadKicks: 2, kicked: true })
  check('compacting → no kick', r.kick === false && r.reason === 'compacting')
  check('compacting → resets deadKicks', r.state.deadKicks === 0)
}
// 1c. unknown (boot/transition) → never kick, does NOT reset deadKicks
{
  const r = decideKick('unknown', { lastInboundId: 5, chatAfterInbound: false }, { lastInboundId: 5, deadKicks: 2, kicked: true })
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
  const r = decideKick('idle', { lastInboundId: 0, chatAfterInbound: false }, newKickState())
  check('idle + nothing owed → no kick', r.kick === false && r.reason === 'nothing-owed')
}
// 4. idle, delivered (chat after inbound) → never kick
{
  const r = decideKick('idle', { lastInboundId: 10, chatAfterInbound: true }, { lastInboundId: 10, deadKicks: 2, kicked: true })
  check('idle + delivered → no kick', r.kick === false && r.reason === 'delivered')
  check('delivered → resets deadKicks', r.state.deadKicks === 0)
  check('delivered → clears kicked flag', r.state.kicked === false)
}
// 5. idle, stalled, first kick → kick with the 'nudge' (Continue text) action.
//    The first kick is free (deadKicks stays 0) but marks `kicked`.
let s = newKickState()
{
  const r = decideKick('idle', { lastInboundId: 10, chatAfterInbound: false }, s)
  check('first stall → kick', r.kick === true && r.reason === 'kick')
  check('idle stall → nudge action', r.action === 'nudge')
  check('first kick → deadKicks 0', r.state.deadKicks === 0)
  check('first kick → marks kicked', r.state.kicked === true)
  s = r.state
}
// 6. still stalled, no delivery → kick, deadKicks climbs
{
  const r = decideKick('idle', { lastInboundId: 10, chatAfterInbound: false }, s)
  check('no-delivery stall → kick', r.kick === true)
  check('no-delivery → deadKicks 1', r.state.deadKicks === 1)
  s = r.state
}
// 7. keep stalling with no delivery until the cap, then stop
{
  for (let i = 0; i < 10 && s.deadKicks < GOOSE_KICK_CAP; i++) {
    const r = decideKick('idle', { lastInboundId: 10, chatAfterInbound: false }, s)
    s = r.state
  }
  check(`reaches cap (deadKicks=${s.deadKicks})`, s.deadKicks === GOOSE_KICK_CAP)
  const r = decideKick('idle', { lastInboundId: 10, chatAfterInbound: false }, s)
  check('at cap → no kick (capped)', r.kick === false && r.reason === 'capped')
  // capping STOPS the kicks (ends the wedge loop) — it does not kill the agent.
  check('capped → kick false', r.kick === false)
  check('capped → state preserved (not torn down)', r.state.lastInboundId === 10)
}
// 8. THE REFINEMENT: a slow goose making non-chat tool calls (reads/greps) but
//    never delivering is NOT progress. Tool activity isn't even represented in
//    `info` anymore — only `chatAfterInbound` matters — so the no-delivery run
//    climbs straight to the cap and re-kicks the whole way. (Before the fix, an
//    advancing tool-call id reset deadKicks every sweep → kick forever, never cap,
//    false-silencing the drill turn.)
{
  let s8 = newKickState()
  let kicks = 0
  let capped = false
  for (let i = 0; i < 12; i++) {
    // simulate the goose doing tool work each sweep but never chatting back
    const r = decideKick('idle', { lastInboundId: 10, chatAfterInbound: false }, s8)
    s8 = r.state
    if (r.kick) kicks += 1
    if (r.reason === 'capped') { capped = true; break }
  }
  check('doc-reader-never-delivers → still re-kicked', kicks >= 1)
  check('doc-reader-never-delivers → eventually caps', capped === true)
  check('doc-reader → cap budget exactly GOOSE_KICK_CAP+1 kicks', kicks === GOOSE_KICK_CAP + 1)
}
// 8b. ...and the moment that same goose finally delivers a chat, the cap resets.
{
  let s8b = { lastInboundId: 10, deadKicks: GOOSE_KICK_CAP - 1, kicked: true }
  const r = decideKick('idle', { lastInboundId: 10, chatAfterInbound: true }, s8b)
  check('delivery after stall → no kick (done)', r.kick === false && r.reason === 'delivered')
  check('delivery after stall → deadKicks reset', r.state.deadKicks === 0)
}
// 9. a fresh inbound resets the whole kick state
{
  let s3 = { lastInboundId: 10, deadKicks: GOOSE_KICK_CAP, kicked: true }
  const r = decideKick('idle', { lastInboundId: 30, chatAfterInbound: false }, s3)
  check('new inbound → kick again', r.kick === true)
  check('new inbound → deadKicks reset', r.state.deadKicks === 0)
  check('new inbound → kicked reset then re-marked', r.state.kicked === true)
  check('new inbound → lastInboundId advanced', r.state.lastInboundId === 30)
}
// 10. STUCK (frozen) with undelivered work → kick with the bare-'enter' action,
//     NOT the nudge — the recovery is to flush the already-queued input.
{
  const r = decideKick('stuck', { lastInboundId: 10, chatAfterInbound: false }, newKickState())
  check('stuck + owed → kick', r.kick === true)
  check('stuck → enter action (bare Enter, not Continue text)', r.action === 'enter')
}
// 11. stuck but already delivered → no kick (don't Enter a done agent)
{
  const r = decideKick('stuck', { lastInboundId: 10, chatAfterInbound: true }, { lastInboundId: 10, deadKicks: 0, kicked: false })
  check('stuck + delivered → no kick', r.kick === false && r.reason === 'delivered')
}
// 12. PENDING (queued msg at prompt, no glyph) with owed work → kick, bare-'enter'
//     action (flush the queued input), same recovery as stuck — NOT the nudge.
{
  const r = decideKick('pending', { lastInboundId: 10, chatAfterInbound: false }, newKickState())
  check('pending + owed → kick', r.kick === true)
  check('pending → enter action (flush queued, not Continue text)', r.action === 'enter')
}
// 13. pending but already delivered → no kick (don't Enter a done agent)
{
  const r = decideKick('pending', { lastInboundId: 10, chatAfterInbound: true }, { lastInboundId: 10, deadKicks: 0, kicked: false })
  check('pending + delivered → no kick', r.kick === false && r.reason === 'delivered')
}
// 14. unknown (boot, no 🪿) is NOT kick-eligible
{
  const r = decideKick('unknown', { lastInboundId: 10, chatAfterInbound: false }, newKickState())
  check('unknown → no kick (boot safety)', r.kick === false && r.reason === 'unknown' && r.action === null)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
