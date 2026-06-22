// Run: node bin/lib/disposition-wiring.test.mjs
//
// Integration test of the bot's decision path end-to-end: it wires the REAL
// DispositionScheduler + REAL createDispositionWiring + REAL pokeFor exactly the
// way bin/disposition-bot.mjs does, then feeds SYNTHETIC fleet-events through a
// fake clock and asserts the observable behavior — no WS, no live agents, no
// real time. This is the "poke fires when Skip's absent + the agent worked,
// silent when present or on a bare reply-to-the-bot; message short + lane-
// correct; bot-triggered continuations do not re-poke) evidence at the wiring level (the scheduler's own gate/lane logic is
// covered in disposition-scheduler.test.mjs).
import { DispositionScheduler } from './disposition-scheduler.mjs'
import { createDispositionWiring } from './disposition-wiring.mjs'
import { pokeFor, POKE } from './disposition-poke.mjs'

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
    isSkipPresent: () => wiring.isSkipPresent(),
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
const activity = (id, tool, input = undefined) => ({
  type: 'activity',
  from_id: id,
  to_id: id,
  metadata: input === undefined ? { tool } : { tool, input },
})
const chatToBotInput = { filter: { to: BOT } }
const POKE_CHAT = (to) => chat(BOT, to, '🪞 self-check') // a poke as it appears on the wire

// 1. Skip ABSENT → poke fires after the countdown, with the universal poke text.
{
  const { clock, poked, wiring } = setup()
  wiring.updateRoster([{ id: 'fleet:a', cwd: '/Users/skip/work/tlda' }])
  wiring.handleFleetEvent(turnEnded('fleet:a'))
  clock.advance(COUNTDOWN_MS + 1000)
  check('absent → poke fires', poked.length === 1 && poked[0].to === 'fleet:a')
  check('poke text is the universal completeness line', poked[0]?.text === POKE)
}

// 2. Skip PRESENT (chatted another agent just now) → a different agent's turn does NOT poke.
{
  const { clock, poked, wiring } = setup()
  wiring.handleFleetEvent(chat(OWNER, 'fleet:b', 'working on it?'))  // presence (global) + cancels b
  wiring.handleFleetEvent(turnEnded('fleet:c'))                      // unrelated agent ends a turn
  clock.advance(COUNTDOWN_MS + 1000)
  check('Skip present → poke suppressed for ALL agents', poked.length === 0)
}

// 3. Presence expires: once Skip's been quiet past the window, pokes resume.
{
  const { clock, poked, wiring } = setup()
  wiring.handleFleetEvent(chat(OWNER, 'fleet:b', 'hi'))   // present at t=0
  clock.advance(PRESENCE_MS + 1000)                       // ...quiet past the window
  wiring.handleFleetEvent(turnEnded('fleet:c'))           // turn ends while he's now absent
  clock.advance(COUNTDOWN_MS + 1000)
  check('presence window expires → poke fires again', poked.length === 1 && poked[0].to === 'fleet:c')
}

// 4. Any lane (math cwd here) → the same universal poke (text no longer branches on cwd).
{
  const { clock, poked, wiring } = setup()
  wiring.updateRoster([{ id: 'fleet:m', cwd: '/Users/skip/work/bregman' }])
  wiring.handleFleetEvent(turnEnded('fleet:m'))
  clock.advance(COUNTDOWN_MS + 1000)
  check('math-lane agent also gets the universal poke', poked.length === 1 && poked[0].text === POKE)
}

// 5. Unknown-cwd agent → still the universal poke.
{
  const { clock, poked, wiring } = setup()
  wiring.handleFleetEvent(turnEnded('fleet:unknown'))  // no roster entry
  clock.advance(COUNTDOWN_MS + 1000)
  check('unknown-cwd agent gets the universal poke', poked.length === 1 && poked[0].text === POKE)
}

// 6. Agent→agent cross-talk does NOT mark Skip present, and (per Skip's final
//    spec) a cross-talk-triggered turn still pokes — we do NOT over-suppress.
{
  const { clock, poked, wiring } = setup()
  wiring.handleFleetEvent(chat('fleet:other', 'fleet:a', 'ping'))   // another agent messages a
  check('cross-talk leaves Skip absent', wiring._lastSkipActivityAt() === 0)
  wiring.handleFleetEvent(turnEnded('fleet:a'))
  clock.advance(COUNTDOWN_MS + 1000)
  check('cross-talk-prompted turn still pokes (Skip absent)', poked.length === 1)
}

// 7. Skip messaging an agent cancels THAT agent's pending countdown.
{
  const { clock, poked, wiring } = setup()
  wiring.handleFleetEvent(turnEnded('fleet:a'))               // countdown starts (Skip absent)
  clock.advance(10_000)
  wiring.handleFleetEvent(chat(OWNER, 'fleet:a', 'hold on'))  // Skip in the room with a → cancel
  clock.advance(COUNTDOWN_MS)
  check('Skip messaging the agent cancels its poke', poked.length === 0)
}

// 8. Manual kick command (Skip → bot) routes to onKickCommand, not a countdown.
{
  const { poked, kicks, wiring } = setup()
  wiring.handleFleetEvent(chat(OWNER, BOT, 'poke fleet:x'))
  check('manual-kick command is routed', kicks.length === 1 && kicks[0] === 'poke fleet:x')
  check('manual-kick command does not itself poke', poked.length === 0)
}

// 9. turn_ended for an ignored id (bot/pseudo-agent) → nothing scheduled.
{
  const { clock, poked, wiring } = setup()
  wiring.handleFleetEvent(turnEnded('fleet:todd'))
  clock.advance(COUNTDOWN_MS + 1000)
  check('ignored agent is never poked', poked.length === 0)
}

// 10. POKE LOOP — bot poked the agent, agent only chatted back (no real work) → SUPPRESS.
{
  const { clock, poked, wiring } = setup()
  wiring.handleFleetEvent(POKE_CHAT('fleet:a'))         // the poke, on the wire (from the bot)
  wiring.handleFleetEvent(activity('fleet:a', '_text')) // agent narrates...
  wiring.handleFleetEvent(activity('fleet:a', 'tlda/chat', chatToBotInput)) // ...and fires a chat reply (a comms tool)
  wiring.handleFleetEvent(turnEnded('fleet:a'))
  clock.advance(COUNTDOWN_MS + 1000)
  check('poke → bare chat reply → suppressed (no loop)', poked.length === 0)
}

// 11. POKE + WORK — bot poked, agent actually edited a file → still suppress.
//     The bot's check created this continuation; don't make the agent answer the
//     same completion question again just because it used tools while answering.
{
  const { clock, poked, wiring } = setup()
  wiring.updateRoster([{ id: 'fleet:a', cwd: '/Users/skip/work/tlda' }])
  wiring.handleFleetEvent(POKE_CHAT('fleet:a'))         // the poke
  wiring.handleFleetEvent(activity('fleet:a', 'Edit'))  // agent did real work
  wiring.handleFleetEvent(turnEnded('fleet:a'))
  clock.advance(COUNTDOWN_MS + 1000)
  check('poke → real work → suppressed (no repeated disposition)', poked.length === 0)
}

// 12. notePoked path (echo-independent): even if the bot never saw its own poke
//     on the wire, the post-poke bare reply is still recognized + suppressed.
{
  const { clock, poked, wiring } = setup()
  wiring.notePoked('fleet:a')                            // the bot recorded its own poke directly
  wiring.handleFleetEvent(activity('fleet:a', '_text'))  // bare reply, no work
  wiring.handleFleetEvent(turnEnded('fleet:a'))
  clock.advance(COUNTDOWN_MS + 1000)
  check('notePoked + bare reply → suppressed without the echo', poked.length === 0)
}

// 13. A real inbound after the poke overrides "bot-triggered" → the turn pokes
//     (it was re-triggered by actual work direction, not the bot).
{
  const { clock, poked, wiring } = setup()
  wiring.handleFleetEvent(POKE_CHAT('fleet:a'))                   // bot poke → bot-triggered
  wiring.handleFleetEvent(chat('fleet:mgr', 'fleet:a', 'new task')) // manager re-triggers the turn
  wiring.handleFleetEvent(turnEnded('fleet:a'))                   // (no work this turn)
  clock.advance(COUNTDOWN_MS + 1000)
  check('newer real inbound overrides bot-trigger → poke fires', poked.length === 1)
}

// 14. Per-turn state is consumed: after a suppressed bare reply, a later
//     autonomous work turn is poked again (suppression doesn't stick).
{
  const { clock, poked, wiring } = setup()
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
