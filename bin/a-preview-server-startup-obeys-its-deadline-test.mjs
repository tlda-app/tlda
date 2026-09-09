#!/usr/bin/env node
// Preview-server readiness has exactly one clock and exactly one victim.
//
// The clock: an absolute deadline taken once at spawn, with every health probe
// bounded by what is left of it. The old poll gave each probe its own fresh
// budget, so a listener that accepts and never answers made the loop's own
// probes pay for the overrun and a "30s" wait ran for minutes. Case 5 is that
// defect: it fails on any implementation whose probes can stretch the window.
//
// The victim: the pid `spawn` returned, and nothing else. Not a pid read back
// out of a pidfile, not whatever `lsof` finds on the port. Case 6 puts an
// unrelated process alongside the child and requires it to survive.
//
// Cases 1-4 are the four startup outcomes a pid poll cannot tell apart: healthy,
// never started, exited with a code, killed by a signal.
import { spawn } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { watchSpawnedChild, noChildFacts, waitForSandboxServer, discardStartedServer } from '../cli/lib/dev-worktree.mjs'

const root = mkdtempSync(join(tmpdir(), 'tlda-preview-readiness-'))
const checks = []
const check = (name, ok) => checks.push([name, ok])
const cleanup = []

// A hand-driven clock. Real time cannot prove "the deadline was not stretched"
// without making the test slow and flaky; a clock the test advances can, and it
// is the same clock the implementation reads through its `now` seam.
function fakeClock(start = 0) {
  let t = start
  return { now: () => t, advance: ms => { t += ms }, sleep: async ms => { t += ms } }
}

function start(script, { command = process.execPath, stdio = 'ignore' } = {}) {
  const child = spawn(command, ['-e', script], { stdio })
  const facts = watchSpawnedChild(child)
  cleanup.push(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } })
  return { child, facts }
}

// Node takes the better part of a second to reach the first line of `-e`, and a
// signal delivered before then is handled by the default disposition, not by the
// handler the script is about to install. So a test about signal handling has to
// wait for the child to SAY it is ready rather than sleep and hope.
function announcesReady(script) {
  const run = start(`${script}; process.stdout.write('ready\\n')`, { stdio: ['ignore', 'pipe', 'ignore'] })
  return Object.assign(run, {
    ready: new Promise(resolve => run.child.stdout.once('data', resolve)),
  })
}

const idle = noChildFacts()

async function settle(facts, options) {
  try {
    return { ok: await waitForSandboxServer(facts, 'https://preview.invalid:5190', options.logPath, options) }
  } catch (error) {
    return { error }
  }
}

// The race cases below hand the implementation a probe that never resolves, so
// an implementation that does not race the child's death against it never
// returns at all. Bound the wait here: a hang has to come back as a named
// failing check, not as a test that sits there until someone kills it.
const TIMED_OUT = Symbol('test-timeout')
function within(ms, promise) {
  let timer
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), ms) }),
  ])
}

// Wait for a child's spawn facts to arrive — `error`/`exit` are events, not
// state, so a test that reads them synchronously reads them too early.
async function settled(facts, ms = 3000) {
  const until = Date.now() + ms
  while (!facts.spawnError && !facts.exit && Date.now() < until) await new Promise(r => setTimeout(r, 20))
  return facts
}

try {
  // 1. Positive control: health before the deadline succeeds, and nothing is killed.
  {
    const logPath = join(root, 'healthy.log')
    writeFileSync(logPath, 'listening on :5190\n')
    const clock = fakeClock()
    let probes = 0
    const one = await settle(idle, {
      logPath, timeoutMs: 30_000, intervalMs: 500,
      now: clock.now, sleep: clock.sleep,
      probe: async () => { probes++; clock.advance(120); return { ok: probes >= 2, status: probes >= 2 ? 200 : 503, error: null } },
    })
    check('health before the deadline is reported healthy', one.ok?.outcome === 'healthy')
    check('a healthy startup is not raised as a failure', one.error === undefined)
    check('it reports how long readiness took', one.ok?.elapsedMs === 740)
    check('it carries the health answer that proved it', one.ok?.lastHealth.status === 200)

    // …and the healthy path never reaches the discard: prove discard is what
    // kills, by showing a live process it is not given stays up.
    const bystander = start('setInterval(() => {}, 1000)')
    await new Promise(r => setTimeout(r, 200))
    check('a process the wait was never given is untouched by a success', bystander.child.exitCode === null && bystander.child.signalCode === null)
  }

  // 2. Never started at all: the errno, not "gone".
  {
    const logPath = join(root, 'spawn-error.log')
    const run = start('process.exit(0)', { command: join(root, 'no-such-binary') })
    await settled(run.facts)
    const two = await settle(run.facts, { logPath, timeoutMs: 30_000, probe: async () => { throw new Error('probe must not run after a spawn error') } })
    const d = two.error?.diagnosis
    check('a server that never starts is classified spawn-error', d?.outcome === 'spawn-error')
    check('the spawn errno is reported', d?.code === 'ENOENT')
    check('a spawn error is not reported as a deadline expiry', d?.outcome !== 'health-deadline')
    check('a missing log is named as missing, not as an empty tail', d?.log.exists === false && d?.log.path === logPath)
  }

  // 3. Exited with a code — and early, without burning the deadline.
  {
    const logPath = join(root, 'exit-code.log')
    const logText = 'server boot\nconfig resolved\nfatal: port in use\n'
    writeFileSync(logPath, logText)
    const run = start('process.exit(7)')
    await settled(run.facts)
    const clock = fakeClock()
    const three = await settle(run.facts, {
      logPath, timeoutMs: 30_000, now: clock.now, sleep: clock.sleep,
      probe: async () => { throw new Error('probe must not run after an exit') },
    })
    const d = three.error?.diagnosis
    check('an exited server is classified exit-before-health', d?.outcome === 'exit-before-health')
    check('its exit code is reported', d?.code === 7)
    check('a clean exit reports no signal', d?.signal === null)
    check('it fails early, without spending the deadline', d?.elapsedMs === 0)
    check('the log path, size and tail are reported', d?.log.size === logText.length && d?.log.tail.endsWith('fatal: port in use'))
  }

  // 4. Killed by a signal — indistinguishable from case 3 under a pid poll.
  {
    const logPath = join(root, 'signal.log')
    const run = start('setInterval(() => {}, 1000)')
    run.child.kill('SIGKILL')
    await settled(run.facts)
    const clock = fakeClock()
    const four = await settle(run.facts, {
      logPath, timeoutMs: 30_000, now: clock.now, sleep: clock.sleep,
      probe: async () => { throw new Error('probe must not run after a signal death') },
    })
    const d = four.error?.diagnosis
    check('a signalled server is classified exit-before-health', d?.outcome === 'exit-before-health')
    check('its signal is reported', d?.signal === 'SIGKILL')
    check('a signalled death carries no exit code', d?.code === null)
    check('it fails early, without spending the deadline', d?.elapsedMs === 0)
  }

  // 5. The defect under repair: slow probes cannot stretch the absolute deadline.
  //    This probe hangs for its whole allowance, the way a listener that accepts
  //    the connection and never answers does. Under a fresh per-probe budget the
  //    loop runs for (probes x budget); under one absolute deadline it stops at
  //    the deadline, having spent the entire window inside a single probe.
  {
    const logPath = join(root, 'wedged.log')
    writeFileSync(logPath, 'listening\n')
    const clock = fakeClock()
    const budgets = []
    const five = await settle(idle, {
      logPath, timeoutMs: 5_000, intervalMs: 500,
      now: clock.now, sleep: clock.sleep,
      probe: async (_base, budgetMs) => {
        budgets.push(budgetMs)
        clock.advance(budgetMs)                       // a listener that never answers
        return { ok: false, status: null, error: 'TimeoutError', budgetMs }
      },
    })
    const d = five.error?.diagnosis
    check('a wedged listener expires the deadline', d?.outcome === 'health-deadline')
    check('the wait ends AT the deadline, not a multiple of it', d?.elapsedMs === 5_000)
    check('a hanging probe is handed the whole remaining window, not a fixed one', budgets.length === 1 && budgets[0] === 5_000)
    check('the last health answer is reported as evidence', d?.lastHealth?.error === 'TimeoutError')
    check('an expiry is not attributed to an exit or a spawn error', d?.code === null && d?.signal === null)
  }

  // 5a. Same rule under repeated slow-but-answering probes: each one is handed
  //     exactly what is left of the deadline, so the budget shrinks every round
  //     and the window closes on time. A fresh 1.5s per probe fails both checks.
  {
    const logPath = join(root, 'slow.log')
    const clock = fakeClock()
    const calls = []
    const slow = await settle(idle, {
      logPath, timeoutMs: 5_000, intervalMs: 500,
      now: clock.now, sleep: clock.sleep,
      probe: async (_base, budgetMs) => {
        calls.push({ budgetMs, at: clock.now() })
        clock.advance(Math.floor(budgetMs / 2))       // slow, but it answers
        return { ok: false, status: 503, error: null, budgetMs }
      },
    })
    const d = slow.error?.diagnosis
    check('repeated slow probes still expire exactly at the deadline', d?.outcome === 'health-deadline' && d?.elapsedMs === 5_000)
    check('more than one probe ran', calls.length > 1)
    check('each probe is given exactly the remaining budget', calls.every(c => c.budgetMs === 5_000 - c.at))
    check('probe budgets shrink monotonically toward the deadline', calls.every((c, i) => i === 0 || c.budgetMs < calls[i - 1].budgetMs))
    check('the last non-ok health answer is reported as evidence', d?.lastHealth?.status === 503)
  }

  // 5b. Health that only arrives AFTER expiry is not success.
  {
    const logPath = join(root, 'late.log')
    const clock = fakeClock()
    const late = await settle(idle, {
      logPath, timeoutMs: 1_000, intervalMs: 100,
      now: clock.now, sleep: clock.sleep,
      probe: async (_base, budgetMs) => { clock.advance(budgetMs); return { ok: true, status: 200, error: null } },
    })
    check('an ok that lands at or past the deadline is not success', late.ok === undefined && late.error?.diagnosis.outcome === 'health-deadline')
  }

  // 6. A child that becomes healthy only after expiry is killed, its owned state
  //    is removed, and an unrelated process is left alone.
  {
    const configDir = join(root, 'preview-config')
    const pidPath = join(root, 'server.pid')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'server.yaml'), 'tokenGating: false\n')
    writeFileSync(pidPath, '999999')

    // The "late bloomer": ignores SIGTERM, so this also exercises escalation.
    const child = announcesReady('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)')
    const unrelated = announcesReady('setInterval(() => {}, 1000)')
    await Promise.all([child.ready, unrelated.ready])

    const discarded = await discardStartedServer(child.child.pid, { configDir, pidPath, graceMs: 400, pollMs: 25 })
    check('the exact spawned pid is the one terminated', discarded.pid === child.child.pid && discarded.signalled === true)
    check('termination is verified, not assumed', discarded.gone === true)
    check('a child that ignores SIGTERM is escalated', discarded.escalated === true)
    check('the preview config it owned is removed', !existsSync(configDir))
    check('its pid state is removed', !existsSync(pidPath))
    check('the removals are reported as evidence', discarded.removed.includes(configDir) && discarded.removed.includes(pidPath))

    await new Promise(r => setTimeout(r, 200))
    check('an unrelated process alongside it survives', unrelated.child.exitCode === null && unrelated.child.signalCode === null)
    check('the discarded child is really dead', child.child.exitCode !== null || child.child.signalCode !== null)
  }

  // 7. The race, not the read. A probe that never resolves owns the rest of the
  //    deadline, so a waiter that only inspects the child's facts BETWEEN probes
  //    cannot report a death that happens inside one — it would sit there until
  //    the deadline and then blame the timeout. Each case here kills the child
  //    mid-probe and requires the death, with its code or signal, immediately.
  for (const [label, script, kill, expect] of [
    ['exit code', 'process.on("SIGTERM", () => process.exit(3)); setInterval(() => {}, 1000)', c => c.kill('SIGTERM'), { code: 3, signal: null }],
    ['signal', 'setInterval(() => {}, 1000)', c => c.kill('SIGKILL'), { code: null, signal: 'SIGKILL' }],
  ]) {
    const logPath = join(root, `midprobe-${label.replace(/\W/g, '-')}.log`)
    const run = announcesReady(script)
    await run.ready

    const started = Date.now()
    const settling = settle(run.facts, {
      logPath, timeoutMs: 60_000,
      // Never resolves. Only the death can end this wait.
      probe: () => new Promise(() => {}),
    })
    // Kill it while the probe is in flight, not before.
    await new Promise(r => setTimeout(r, 150))
    kill(run.child)
    const result = await within(15_000, settling)
    const took = Date.now() - started
    const d = result === TIMED_OUT ? null : result.error?.diagnosis
    check(`a mid-probe ${label} death ends the wait at all`, result !== TIMED_OUT)

    check(`a mid-probe ${label} death is reported as a child death, not a timeout`, d?.outcome === 'exit-before-health')
    check(`a mid-probe ${label} death settles immediately, not at the deadline`, took < 10_000)
    check(`the mid-probe ${label} is reported`, d?.code === expect.code && d?.signal === expect.signal)
    check(`a mid-probe ${label} death is not classified health-deadline`, d?.outcome !== 'health-deadline')
  }

  // 7b. Same race for a spawn error: the child never starts while the probe hangs.
  {
    const logPath = join(root, 'midprobe-spawn.log')
    const run = start('process.exit(0)', { command: join(root, 'no-such-binary') })
    const started = Date.now()
    const seven = await within(15_000, settle(run.facts, { logPath, timeoutMs: 60_000, probe: () => new Promise(() => {}) }))
    const d = seven === TIMED_OUT ? null : seven.error?.diagnosis
    check('a spawn error during a hanging probe ends the wait at all', seven !== TIMED_OUT)
    check('a spawn error during a hanging probe settles as spawn-error', d?.outcome === 'spawn-error' && d?.code === 'ENOENT')
    check('it settles immediately, not at the deadline', Date.now() - started < 10_000)
  }

  // 8. A server that survives SIGTERM and SIGKILL. No real process can, so the
  //    liveness and signal seams are stubbed — the point under test is the
  //    decision, not the kernel. Its pidfile and config are the ONLY record that
  //    the thing still on that port belongs to this preview, so a still-alive
  //    outcome must keep them: deleting them would leave an unowned server and
  //    no way to find out it was ours.
  {
    const configDir = join(root, 'immortal-config')
    const pidPath = join(root, 'immortal.pid')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, 'server.yaml'), 'tokenGating: false\n')
    writeFileSync(pidPath, '424242')

    const unrelated = announcesReady('setInterval(() => {}, 1000)')
    await unrelated.ready

    const signals = []
    const immortal = await discardStartedServer(424242, {
      configDir, pidPath, graceMs: 200, pollMs: 25,
      isAlive: () => true,                              // survives everything
      signalTo: (p, sig) => signals.push([p, sig]),
    })

    check('a server surviving TERM and KILL is reported still-alive', immortal.reason === 'still-alive' && immortal.gone === false)
    check('still-alive is distinct from terminated', immortal.reason !== 'terminated')
    check('it escalated before giving up', immortal.escalated === true)
    check('exactly SIGTERM then SIGKILL, to that pid and no other', JSON.stringify(signals) === JSON.stringify([[424242, 'SIGTERM'], [424242, 'SIGKILL']]))
    check('its preview config is RETAINED while it is alive', existsSync(configDir))
    check('its pid state is RETAINED while it is alive', existsSync(pidPath))
    check('nothing is reported as removed', immortal.removed.length === 0)
    check('the retained ownership evidence is named', immortal.retained.includes(configDir) && immortal.retained.includes(pidPath))
    check('an unrelated process is untouched by a still-alive outcome', unrelated.child.exitCode === null && unrelated.child.signalCode === null)
  }

  // 6b. Nothing to kill is not an excuse to skip the cleanup.
  {
    const configDir = join(root, 'never-spawned-config')
    mkdirSync(configDir, { recursive: true })
    const never = await discardStartedServer(undefined, { configDir })
    check('a server that never got a pid still has its state removed', never.reason === 'never-spawned' && !existsSync(configDir))
    check('nothing is signalled when there is no pid', never.signalled === false)
  }

  for (const [name, ok] of checks) console.log(`${ok ? '  ok  ' : '  FAIL '}${name}`)
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1
} finally {
  for (const undo of cleanup) undo()
  rmSync(root, { recursive: true, force: true })
}
