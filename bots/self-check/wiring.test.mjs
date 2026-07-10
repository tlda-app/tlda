// Run: node bots/self-check/wiring.test.mjs
//
// Integration test of the bot's decision path end-to-end: it wires the REAL
// DispositionScheduler + REAL createDispositionWiring + REAL pokeFor exactly the
// way bots/disposition.mjs does, then feeds SYNTHETIC fleet-events through a
// fake clock and asserts the observable behavior — no WS, no live agents, no
// real time. This is the "poke fires when Skip's absent from that target agent's
// room + the agent worked, silent when present with that target or on a bare
// reply-to-the-bot; message short + lane-correct" evidence at the wiring level
// (the scheduler's own gate/lane logic is covered in disposition-scheduler.test.mjs).
import { DispositionScheduler } from './scheduler.mjs'
import { createDispositionWiring } from './wiring.mjs'
import { pokeFor, POKE } from './poke.mjs'

// ── Fake clock shared by the scheduler timers AND the wiring's now() ──────────
function makeClock() {
  let nextId = 1
  const timers = new Map()
  // Start well past the presence window so "Skip unseen" (lastSkipActivityAt=0)
  // reads as absent, mirroring production where now()=Date.now() dwarfs 0.
  let now = 10_000_000
  return {
    now: () => now,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fireAt: now + ms, fn }); return id },
    clearTimer: (id) => { timers.delete(id) },
    advance: (ms) => {
      now += ms
      for (const [id, t] of [...timers].sort((a, b) => a[1].fireAt - b[1].fireAt)) {
        if (t.fireAt <= now) { timers.delete(id); t.fn() }
      }
    },
  }
}

let pass = 0, fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}`) }
}

const OWNER = 'fleet:skip'
const BOT = 'fleet:disposition'
const IGNORE = new Set([OWNER, BOT, 'fleet:todd', 'fleet:tlda', 'fleet:teacher', 'fleet:eliza'])
const PRESENCE_MS = 120_000
const COUNTDOWN_MS = 30_000

// Build the same scheduler+wiring graph the bot builds (scheduler's sendPoke /
// isSkipPresent close over `wiring`; sendPoke calls notePoked first, as the bot does).
function setup() {
  const clock = makeClock()
  const poked = []  // { to, text }
  const kicks = []  // raw manual-kick command strings
  let wiring
  const scheduler = new DispositionScheduler({
    countdownMs: COUNTDOWN_MS,
    sendPoke: (id) => { wiring.notePoked(id); poked.push({ to: id, text: pokeFor(wiring.cwdOf(id)) }) },
    isSkipPresent: (id) => wiring.isSkipPresent(id),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  wiring = createDispositionWiring({
    scheduler,
    ownerId: OWNER,
    agentId: BOT,
    ignoreIds: IGNORE,
    presenceWindowMs: PRESENCE_MS,
    onKickCommand: (text) => kicks.push(text),
    now: clock.now,
  })
  return { clock, poked, kicks, wiring }
}

const turnEnded = (id) => ({ type: 'turn_ended', agent_id: id })
const chat = (from, to, text) => ({ type: 'chat', from_id: from, to_id: to, text })
const delegated = (to) => ({ type: 'delegate', agent_id: to })
const activity = (id, tool, input = undefined) => ({
  type: 'activity',
  from_id: id,
  to_id: id,
  metadata: input === undefined ? { tool } : { tool, input },
})
const chatToBotInput = { filter: { to: BOT } }
const POKE_CHAT = (to) => chat(BOT, to, '🪞 self-check') // a poke as it appears on the wire

// 1. No real chat/delegation antecedent → no poke. A fresh taskless startup
//    turn must not be told to continue a task it does not have.
{
  const { clock, poked, wiring } = setup()
  wiring.handleFleetEvent(turnEnded('fleet:new'))
  clock.advance(COUNTDOWN_MS + 1000)
  check('no inbound/delegation antecedent → no poke', poked.length === 0)
}

// 2. Skip ABSENT + real delegation → poke fires after the countdown, with the
//    universal poke text.
{
  const { clock, poked, wiring } = setup()
  wiring.updateRoster([{ id: 'fleet:a', cwd: '/Users/skip/work/tlda' }])
  wiring.handleFleetEvent(delegated('fleet:a'))
  wiring.handleFleetEvent(activity('fleet:a', 'Edit'))
  wiring.handleFleetEvent(turnEnded('fleet:a'))
  clock.advance(COUNTDOWN_MS + 1000)
  check('delegated + absent → poke fires', poked.length === 1 && poked[0].to === 'fleet:a')
  check('poke text is the universal completeness line', poked[0]?.text === POKE)
}

// 3. Delegated/addressed but non-substantive turn → no poke.
{
  const { clock, poked, wiring } = setup()
  wiring.handleFleetEvent(delegated('fleet:a'))
  wiring.handleFleetEvent(activity('fleet:a', '_text'))
  wiring.handleFleetEvent(turnEnded('fleet:a'))
  clock.advance(COUNTDOWN_MS + 1000)
  check('delegated but non-substantive turn → no poke', poked.length === 0)
}

// 4. Skip PRESENT with another agent does NOT suppress this target agent.
{
  const { clock, poked, wiring } = setup()
  wiring.handleFleetEvent(chat(OWNER, 'fleet:b', 'working on it?'))  // presence with b + cancels b
  wiring.handleFleetEvent(delegated('fleet:c'))
  wiring.handleFleetEvent(activity('fleet:c', 'Edit'))
  wiring.handleFleetEvent(turnEnded('fleet:c'))                      // unrelated agent ends a turn
  clock.advance(COUNTDOWN_MS + 1000)
  check('Skip with b does not suppress c', poked.length === 1 && poked[0].to === 'fleet:c')
}

// 5. Same-target presence suppresses while fresh, then expires.
{
  const { clock, poked, wiring } = setup()
  wiring.handleFleetEvent(chat(OWNER, 'fleet:c', 'hi'))   // present with c at t=0
  wiring.handleFleetEvent(activity('fleet:c', 'Edit'))
  wiring.handleFleetEvent(turnEnded('fleet:c'))
  clock.advance(COUNTDOWN_MS + 1000)
  check('Skip present with c suppresses c', poked.length === 0)
  clock.advance(PRESENCE_MS + 1000)                       // ...quiet past the window
  wiring.handleFleetEvent(activity('fleet:c', 'Edit'))
  wiring.handleFleetEvent(turnEnded('fleet:c'))           // turn ends while he's now absent from c
  clock.advance(COUNTDOWN_MS + 1000)
  check('same-target presence window expires → poke fires again', poked.length === 1 && poked[0].to === 'fleet:c')
}

// 6. Any lane (math cwd here) → the same universal poke (text no longer branches on cwd).
{
  const { clock, poked, wiring } = setup()
  wiring.updateRoster([{ id: 'fleet:m', cwd: '/Users/skip/work/bregman' }])
  wiring.handleFleetEvent(delegated('fleet:m'))
  wiring.handleFleetEvent(activity('fleet:m', 'Edit'))
  wiring.handleFleetEvent(turnEnded('fleet:m'))
  clock.advance(COUNTDOWN_MS + 1000)
  check('math-lane agent also gets the universal poke', poked.length === 1 && poked[0].text === POKE)
}

// 7. Unknown-cwd agent with a real chat antecedent → still the universal poke.
{
  const { clock, poked, wiring } = setup()
  wiring.handleFleetEvent(chat('fleet:mgr', 'fleet:unknown', 'please handle this'))
  wiring.handleFleetEvent(activity('fleet:unknown', 'Edit'))
  wiring.handleFleetEvent(turnEnded('fleet:unknown'))  // no roster entry
  clock.advance(COUNTDOWN_MS + 1000)
  check('unknown-cwd addressed agent gets the universal poke', poked.length === 1 && poked[0].text === POKE)
}

// 8. Agent→agent cross-talk does NOT mark Skip present, and (per Skip's final
//    spec) a cross-talk-triggered turn still pokes — we do NOT over-suppress.
{
  const { clock, poked, wiring } = setup()
  wiring.handleFleetEvent(chat('fleet:other', 'fleet:a', 'ping'))   // another agent messages a
  check('cross-talk leaves Skip absent from a', wiring._lastSkipActivityAt('fleet:a') === 0)
  wiring.handleFleetEvent(activity('fleet:a', 'Edit'))
  wiring.handleFleetEvent(turnEnded('fleet:a'))
  clock.advance(COUNTDOWN_MS + 1000)
  check('cross-talk-prompted turn still pokes (Skip absent)', poked.length === 1)
}

// 9. Skip messaging an agent cancels THAT agent's pending countdown.
{
  const { clock, poked, wiring } = setup()
  wiring.handleFleetEvent(delegated('fleet:a'))
  wiring.handleFleetEvent(activity('fleet:a', 'Edit'))
  wiring.handleFleetEvent(turnEnded('fleet:a'))               // countdown starts (Skip absent)
  clock.advance(10_000)
  wiring.handleFleetEvent(chat(OWNER, 'fleet:a', 'hold on'))  // Skip in the room with a → cancel
  clock.advance(COUNTDOWN_MS)
  check('Skip messaging the agent cancels its poke', poked.length === 0)
}

// 10. Manual kick command (Skip → bot) routes to onKickCommand, not a countdown.
{
  const { poked, kicks, wiring } = setup()
  wiring.handleFleetEvent(chat(OWNER, BOT, 'poke fleet:x'))
  check('manual-kick command is routed', kicks.length === 1 && kicks[0] === 'poke fleet:x')
  check('manual-kick command does not itself poke', poked.length === 0)
}

// 11. turn_ended for an ignored id (bot/pseudo-agent) → nothing scheduled.
{
  const { clock, poked, wiring } = setup()
  wiring.handleFleetEvent(turnEnded('fleet:todd'))
  clock.advance(COUNTDOWN_MS + 1000)
  check('ignored agent is never poked', poked.length === 0)
}

// 12. POKE LOOP — bot poked the agent, agent only chatted back (no real work) → SUPPRESS.
{
  const { clock, poked, wiring } = setup()
  wiring.handleFleetEvent(delegated('fleet:a'))
  wiring.handleFleetEvent(POKE_CHAT('fleet:a'))         // the poke, on the wire (from the bot)
  wiring.handleFleetEvent(activity('fleet:a', '_text')) // agent narrates...
  wiring.handleFleetEvent(activity('fleet:a', 'tlda/chat', chatToBotInput)) // ...and fires a chat reply (a comms tool)
  wiring.handleFleetEvent(turnEnded('fleet:a'))
  clock.advance(COUNTDOWN_MS + 1000)
  check('poke → bare chat reply → suppressed (no loop)', poked.length === 0)
}

// 13. POKE + WORK — bot poked, agent actually edited a file → follow-up poke OK.
{
  const { clock, poked, wiring } = setup()
  wiring.updateRoster([{ id: 'fleet:a', cwd: '/Users/skip/work/tlda' }])
  wiring.handleFleetEvent(delegated('fleet:a'))
  wiring.handleFleetEvent(POKE_CHAT('fleet:a'))         // the poke
  wiring.handleFleetEvent(activity('fleet:a', 'Edit'))  // agent did real work
  wiring.handleFleetEvent(turnEnded('fleet:a'))
  clock.advance(COUNTDOWN_MS + 1000)
  check('poke → real work → follow-up poke fires', poked.length === 1 && poked[0].to === 'fleet:a')
}

// 14. notePoked path (echo-independent): even if the bot never saw its own poke
//     on the wire, the post-poke bare reply is still recognized + suppressed.
{
  const { clock, poked, wiring } = setup()
  wiring.handleFleetEvent(delegated('fleet:a'))
  wiring.notePoked('fleet:a')                            // the bot recorded its own poke directly
  wiring.handleFleetEvent(activity('fleet:a', '_text'))  // bare reply, no work
  wiring.handleFleetEvent(turnEnded('fleet:a'))
  clock.advance(COUNTDOWN_MS + 1000)
  check('notePoked + bare reply → suppressed without the echo', poked.length === 0)
}

// 15. A real inbound after the poke overrides "bot-triggered" → the turn pokes
//     (it was re-triggered by actual work direction, not the bot).
{
  const { clock, poked, wiring } = setup()
  wiring.handleFleetEvent(POKE_CHAT('fleet:a'))                   // bot poke → bot-triggered
  wiring.handleFleetEvent(chat('fleet:mgr', 'fleet:a', 'new task')) // manager re-triggers the turn
  wiring.handleFleetEvent(activity('fleet:a', 'Edit'))
  wiring.handleFleetEvent(turnEnded('fleet:a'))
  clock.advance(COUNTDOWN_MS + 1000)
  check('newer real inbound overrides bot-trigger → poke fires', poked.length === 1)
}

// 16. Per-turn state is consumed: after a suppressed bare reply, a later
//     autonomous work turn is poked again (suppression doesn't stick).
{
  const { clock, poked, wiring } = setup()
  wiring.handleFleetEvent(delegated('fleet:a'))
  wiring.handleFleetEvent(POKE_CHAT('fleet:a'))
  wiring.handleFleetEvent(activity('fleet:a', 'tlda/chat', chatToBotInput))
  wiring.handleFleetEvent(turnEnded('fleet:a'))  // suppressed (bare reply to bot)
  check('the bare-reply turn was suppressed', poked.length === 0)
  wiring.handleFleetEvent(activity('fleet:a', 'Bash'))  // later, real autonomous work
  wiring.handleFleetEvent(turnEnded('fleet:a'))
  clock.advance(COUNTDOWN_MS + 1000)
  check('a later autonomous work turn pokes again', poked.length === 1)
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
