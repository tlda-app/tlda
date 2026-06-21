// Run: node bin/lib/disposition-scheduler.test.mjs
// Exercises the countdown / cancel-on-Skip-message / manual-kick logic with a
// fake clock — no real time, no WS. Replaces the old regex-check test.
import { DispositionScheduler } from './disposition-scheduler.mjs'
import { GENERIC_POKE, pokeFor } from './disposition-poke.mjs'

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

// 2. Skip messages the agent before expiry → countdown cancelled, no poke.
{
  const { clock, poked, sched } = setup()
  sched.onTurnEnd('fleet:a')
  clock.advance(10_000)
  sched.onSkipMessage('fleet:a')
  clock.advance(30_000)
  check('Skip message cancels the poke', poked.length === 0)
  check('no timer left pending after cancel', clock.pendingCount() === 0)
}

// 3. Per-agent scope: Skip messaging X does NOT cancel Y's countdown.
{
  const { clock, poked, sched } = setup()
  sched.onTurnEnd('fleet:x')
  sched.onTurnEnd('fleet:y')
  sched.onSkipMessage('fleet:x')
  clock.advance(31_000)
  check('only the messaged agent is spared', poked.length === 1 && poked[0] === 'fleet:y')
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

// 8. Poke text is the grounded generic poke (and pokeFor returns it in v1).
{
  check('poke text mentions the actual-thing gate', /the thing Skip asked/i.test(GENERIC_POKE))
  check('poke text mentions verification gate', /verify, or am I assuming/i.test(GENERIC_POKE))
  check('poke text mentions the make-him-steer gate', /making Skip steer/i.test(GENERIC_POKE))
  check('pokeFor returns the generic poke in v1', pokeFor('/any/dir') === GENERIC_POKE)
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
