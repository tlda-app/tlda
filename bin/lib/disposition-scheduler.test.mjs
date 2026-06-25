// Run: node bin/lib/disposition-scheduler.test.mjs
// Exercises the countdown / cancel-on-Skip-message / manual-kick logic with a
// fake clock — no real time, no WS. Replaces the old regex-check test.
import { DispositionScheduler } from './disposition-scheduler.mjs'
import { POKE, pokeFor } from './disposition-poke.mjs'

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

// 8. Skip-absence gate: present at fire time → suppressed; absent → poke.
{
  let present = true
  const { clock, poked, sched } = setup({ isSkipPresent: () => present })
  sched.onTurnEnd('fleet:a')
  clock.advance(31_000)
  check('Skip present at fire time → no poke', poked.length === 0)
  present = false
  sched.onTurnEnd('fleet:a')
  clock.advance(31_000)
  check('Skip absent at fire time → poke fires', poked.length === 1 && poked[0] === 'fleet:a')
}

// 9. Presence is checked at FIRE time: present at turn-end but gone by expiry → poke.
{
  let present = true
  const { clock, poked, sched } = setup({ isSkipPresent: () => present })
  sched.onTurnEnd('fleet:a') // countdown starts while Skip is present
  clock.advance(15_000)
  present = false            // Skip goes quiet mid-countdown
  clock.advance(16_000)
  check('Skip leaving mid-countdown lets the poke fire', poked.length === 1 && poked[0] === 'fleet:a')
}

// 10. Manual kick bypasses the presence gate (Skip's explicit command).
{
  const { poked, sched } = setup({ isSkipPresent: () => true })
  const ok = sched.kick('fleet:a')
  check('kick fires even when Skip is present', ok === true && poked.length === 1 && poked[0] === 'fleet:a')
}

// 11. Poke is ONE short next-action line — no checklist, no method/test verbs.
{
  check('poke is a single short line', !/\n/.test(POKE) && POKE.length < 200)
  check('poke asks for the next unresolved action', /next unresolved action/i.test(POKE))
  check('poke requires doing self-servable work before reporting', /do it now/i.test(POKE))
  check('poke prescribes no verification method (no browser/test/run/reload verbs)',
    !/browser|run the test|\bdrove\b|reload/i.test(POKE))
}

// 12. pokeFor returns the ONE universal poke regardless of cwd (lane-adaptiveness
//     now lives in the agent's own skills, not in branched poke text).
{
  check('code dir → universal poke', pokeFor('/Users/skip/work/tlda') === POKE)
  check('math dir → universal poke', pokeFor('/Users/skip/work/bregman') === POKE)
  check('null cwd → universal poke', pokeFor(null) === POKE)
  check('unknown dir → universal poke', pokeFor('/tmp/whatever') === POKE)
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
