// Run: node bots/self-check/scheduler.test.mjs
// Exercises the countdown / restart / manual-kick logic with a
// fake clock — no real time, no WS. Replaces the old regex-check test.
import { DispositionScheduler } from './scheduler.mjs'
import { POKE, pokeFor } from './poke.mjs'

// ── Fake clock: a setTimer/clearTimer pair we advance by hand ──────────────
function makeClock() {
  let nextId = 1
  const timers = new Map() // id → { fireAt, fn }
  let now = 0
  return {
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fireAt: now + ms, fn }); return id },
    clearTimer: (id) => { timers.delete(id) },
    advance: (ms) => {
      now += ms
      for (const [id, t] of [...timers].sort((a, b) => a[1].fireAt - b[1].fireAt)) {
        if (t.fireAt <= now) { timers.delete(id); t.fn() }
      }
    },
    pendingCount: () => timers.size,
  }
}

let pass = 0, fail = 0
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}`) }
}

function setup(opts = {}) {
  const clock = makeClock()
  const poked = []
  const sched = new DispositionScheduler({
    countdownMs: 30_000,
    sendPoke: (id) => poked.push(id),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...opts,
  })
  return { clock, poked, sched }
}

// 1. Countdown expires with no Skip message → poke fires.
{
  const { clock, poked, sched } = setup()
  sched.onTurnEnd('fleet:a')
  clock.advance(29_999)
  check('no poke before countdown elapses', poked.length === 0)
  clock.advance(2)
  check('poke fires after countdown', poked.length === 1 && poked[0] === 'fleet:a')
}

// 2. Skip messages are not scheduler input: the private continuation check still fires.
{
  const { clock, poked, sched } = setup()
  sched.onTurnEnd('fleet:a')
  clock.advance(10_000)
  clock.advance(30_000)
  check('continuation poke fires independently of conversation', poked.length === 1)
  check('no timer left pending after fire', clock.pendingCount() === 0)
}

// 3. Per-agent scope: both agents keep independent countdowns.
{
  const { clock, poked, sched } = setup()
  sched.onTurnEnd('fleet:x')
  sched.onTurnEnd('fleet:y')
  clock.advance(31_000)
  check('both agents are checked independently', poked.length === 2 && poked.includes('fleet:x') && poked.includes('fleet:y'))
}

// 4. New turn supersedes the old countdown (restart, single poke at the end).
{
  const { clock, poked, sched } = setup()
  sched.onTurnEnd('fleet:a')
  clock.advance(20_000)
  sched.onTurnEnd('fleet:a') // restart
  clock.advance(20_000)      // 40s since first turn, only 20s since restart
  check('restarted countdown has not fired yet', poked.length === 0)
  clock.advance(11_000)
  check('restarted countdown fires once', poked.length === 1)
}

// 5. Manual kick pokes immediately and clears any pending countdown.
{
  const { clock, poked, sched } = setup()
  sched.onTurnEnd('fleet:a')
  const ok = sched.kick('fleet:a')
  check('kick returns true', ok === true)
  check('kick pokes immediately', poked.length === 1 && poked[0] === 'fleet:a')
  clock.advance(31_000)
  check('kick consumed the pending countdown (no double poke)', poked.length === 1)
}

// 6. Disabled bot: no countdowns start, kick is a no-op, existing timers clear.
{
  const { clock, poked, sched } = setup()
  sched.onTurnEnd('fleet:a')
  sched.setEnabled(false)
  check('disabling clears pending timers', clock.pendingCount() === 0)
  sched.onTurnEnd('fleet:b')
  check('disabled onTurnEnd starts nothing', clock.pendingCount() === 0)
  check('disabled kick is a no-op', sched.kick('fleet:b') === false)
  clock.advance(60_000)
  check('disabled bot never pokes', poked.length === 0)
}

// 7. Live countdown-duration change feeds the next countdown.
{
  const { clock, poked, sched } = setup()
  sched.setCountdownMs(5_000)
  sched.onTurnEnd('fleet:a')
  clock.advance(5_001)
  check('shortened countdown fires at the new duration', poked.length === 1)
}

// 8. Manual kick fires immediately (Skip's explicit command).
{
  const { poked, sched } = setup()
  const ok = sched.kick('fleet:a')
  check('kick fires immediately', ok === true && poked.length === 1 && poked[0] === 'fleet:a')
}

// 9. Poke is ONE short next-action line — no checklist, no method/test verbs.
{
  check('poke is a single short line', !/\n/.test(POKE) && POKE.length < 200)
  check('poke asks for the next unresolved action', /next unresolved action/i.test(POKE))
  check('poke requires doing self-servable work before reporting', /do it now/i.test(POKE))
  check('poke prescribes no verification method (no browser/test/run/reload verbs)',
    !/browser|run the test|\bdrove\b|reload/i.test(POKE))
}

// 10. pokeFor returns the ONE universal poke regardless of cwd (lane-adaptiveness
//     now lives in the agent's own skills, not in branched poke text).
{
  check('code dir → universal poke', pokeFor('/Users/skip/work/tlda') === POKE)
  check('math dir → universal poke', pokeFor('/Users/skip/work/bregman') === POKE)
  check('null cwd → universal poke', pokeFor(null) === POKE)
  check('unknown dir → universal poke', pokeFor('/tmp/whatever') === POKE)
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
