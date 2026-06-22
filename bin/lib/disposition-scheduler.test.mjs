// Run: node bin/lib/disposition-scheduler.test.mjs
// Exercises the countdown / cancel-on-Skip-message / manual-kick logic with a
// fake clock — no real time, no WS. Replaces the old regex-check test.
import { DispositionScheduler } from './disposition-scheduler.mjs'
import { GENERIC_POKE, MATH_POKE, CODE_POKE, pokeFor } from './disposition-poke.mjs'

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

// 11. Poke is SHORT (no multi-point numbered checklist) and grounded.
{
  check('generic poke has no numbered checklist', !/\n\s*1\./.test(GENERIC_POKE))
  check('generic poke is short (< 400 chars)', GENERIC_POKE.length < 400)
  check('generic poke names the actual-thing gate', /actual thing Skip asked/i.test(GENERIC_POKE))
  check('generic poke names verify + no-punt', /verify it/i.test(GENERIC_POKE) && /go check it/i.test(GENERIC_POKE))
}

// 12. pokeFor routes by lane (cwd); generic for unknown/unset.
{
  check('tlda dir → code poke', pokeFor('/Users/skip/work/tlda') === CODE_POKE)
  check('tlda worktree sibling → code poke', pokeFor('/Users/skip/work/tlda-buildq') === CODE_POKE)
  check('tlda .worktree subdir → code poke', pokeFor('/Users/skip/work/tlda/.worktrees/x') === CODE_POKE)
  check('fleet dir → code poke', pokeFor('/Users/skip/work/fleet/server') === CODE_POKE)
  check('paper dir under work → math poke', pokeFor('/Users/skip/work/bregman') === MATH_POKE)
  check('another work dir → math poke', pokeFor('/Users/skip/work/spinoffs/code') === MATH_POKE)
  check('null cwd → generic poke', pokeFor(null) === GENERIC_POKE)
  check('empty cwd → generic poke', pokeFor('') === GENERIC_POKE)
  check('non-work dir → generic poke', pokeFor('/tmp/whatever') === GENERIC_POKE)
  check('the three lane pokes are distinct', GENERIC_POKE !== MATH_POKE && MATH_POKE !== CODE_POKE && GENERIC_POKE !== CODE_POKE)
  check('math poke speaks proof language', /defined|quantifier|proof/i.test(MATH_POKE))
  check('code poke speaks verify/surface language', /verify|browser|surface/i.test(CODE_POKE))
  check('each lane poke is short (< 400 chars)', MATH_POKE.length < 400 && CODE_POKE.length < 400)
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
