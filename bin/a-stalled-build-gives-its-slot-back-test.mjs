#!/usr/bin/env node
//
// **A build slot came back only when the worker process EXITED.**
//
// Nothing bounded that. A worker found on the live box had been sitting in
// state `T` -- suspended, 0.2% CPU, no LaTeX child, on a box at load 0.28 --
// for 34 minutes, and it was still holding its slot. The queue ran at half
// capacity for the whole period, and every edit that queued behind it was
// logged as `proposal admission confirmed` and then never built.
//
// With every slot held that way, the server stops building anything at all,
// for every project, until it is restarted. Skip, 2026-08-26: *"we really,
// really, really need consistent behavior. Like, we can't have builds just,
// like, locking up."*
//
// **An in-process timeout cannot catch it.** The worker's own timers are
// suspended along with the worker, which is why the `timeout: 120000` on every
// command in `build-runner.mjs` never fired. The bound has to be held by the
// parent.
//
// **The signal is silence, not duration**, and that distinction is the reason
// this is testable at all. A wall-clock limit cannot separate a stalled tex
// pass from a large qmd render that legitimately runs for minutes -- Skip put
// exactly that objection: a tex build should take *"ten fifteen seconds"* while
// a render can run far longer. Builds stream their output, so a healthy build
// of any length keeps talking, and only a stopped one goes quiet.
//
// Asserted here as behaviour: a worker that says nothing loses its slot, and a
// worker that keeps talking keeps it however long it runs.
import assert from 'node:assert/strict'
import { createBuildQueue } from '../server/lib/build-queue.mjs'

// A transport that starts jobs and never finishes them on its own, so what is
// in flight is directly observable. `cancel()` is what the queue reaches for
// when it decides a build has stalled; exiting on cancel is what a real
// forked worker does.
function harness(options) {
  const running = []
  const settled = []
  const transport = {
    start(job, handlers) {
      const entry = { job, handlers, cancelled: false }
      running.push(entry)
      return {
        cancel() {
          entry.cancelled = true
          handlers.onExit(null)
        },
      }
    },
  }
  const queue = createBuildQueue({
    transport,
    getProjectsDir: () => '/projects',
    relayMessage() {},
    recordDisposition: async (job, state) => { settled.push({ name: job.name, state }) },
    logError() {},
  }, options)
  return { queue, running, settled }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

// ---------------------------------------------------------------------------
// 1. THE FAULT. A worker that goes silent loses its slot.
//
// A small threshold and a real wait, on purpose. The watchdog is a real timer;
// advancing a fake clock would prove the arithmetic and never fire it.

{
  const { queue, running, settled } = harness({ maxConcurrency: 1, stallTimeoutMs: 200 })

  queue.admitBuild('alpha', { revision: 'a1', daemonId: 'd1', branch: 'main' })
  await tick()
  assert.equal(running.length, 1, 'the first build starts')

  // A second project queues behind the only slot.
  queue.admitBuild('beta', { revision: 'b1', daemonId: 'd1', branch: 'main' })
  await tick()
  assert.equal(running.length, 1, 'and the second waits, because there is one slot')

  // The first worker stops saying anything. Real time passes, so the real
  // watchdog really fires.
  await new Promise(resolve => setTimeout(resolve, 500))
  await tick()

  assert.equal(running[0].cancelled, true,
    'THE FIX: a build silent past the threshold is stopped and its slot released')
  assert.equal(running.length, 2,
    `and the queued build then runs (saw ${running.length} started in total)`)
  assert.equal(running[1].job.name, 'beta', 'and it is the one that was waiting')

  const alpha = settled.find(entry => entry.name === 'alpha')
  assert.equal(alpha?.state, 'failed',
    `a stall settles as FAILED, not killed -- killed is for something somebody asked to stop (saw ${alpha?.state})`)
}

// ---------------------------------------------------------------------------
// 2. THE COUNTERFACTUAL THAT MATTERS MOST. A long build that keeps talking is
//    NOT stopped.
//
// This is the assertion that makes the feature safe to ship. A threshold that
// fires on a healthy build gets turned off, and then it catches nothing --
// `AGENTS.md` §"An instrument that answers is not an instrument that measured".

{
  const { queue, running } = harness({ maxConcurrency: 1, stallTimeoutMs: 200 })

  queue.admitBuild('slow-render', { revision: 'r1', daemonId: 'd1', branch: 'main' })
  await tick()
  const worker = running[0]

  // Work lasting many times the threshold, narrating as it goes. Never silent
  // for a whole threshold, so it must survive.
  for (let step = 0; step < 12; step += 1) {
    worker.handlers.onMessage({ t: 'report', m: 'buildOutput', a: ['slow-render', `[quarto] page ${step}`] })
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  await tick()

  assert.equal(worker.cancelled, false,
    'a build running many times the threshold, streaming throughout, is left alone -- silence is the signal, not duration')
  assert.equal(running.length, 1, 'and nothing else was started in its place')
}

// ---------------------------------------------------------------------------
// 3. Disabled by configuration means disabled.
//
// Nothing here exists to protect anyone from a decision they meant to make.

{
  const { queue, running } = harness({ maxConcurrency: 1, stallTimeoutMs: 0 })

  queue.admitBuild('gamma', { revision: 'g1', daemonId: 'd1', branch: 'main' })
  await tick()
  await new Promise(resolve => setTimeout(resolve, 500))
  await tick()

  assert.equal(running[0].cancelled, false,
    'with the threshold set to 0, a silent build is never stopped')
}

// ---------------------------------------------------------------------------
// 4. THE WIRE, with a real child process.
//
// Everything above drives the queue with synthetic messages, which proves the
// queue and says nothing about whether a real build actually produces any. That
// is the sender-and-receiver-but-no-wire shape this repository keeps being
// bitten by, and here it would be invisible: the queue would be correct, no
// build would ever emit anything, and every build would look stalled at 90s.
//
// `exec` buffers stdout and hands it over only when the command exits. So this
// asserts TIMING, not content -- a line has to arrive while the command is
// still running. Buffered output would deliver all three at the end and still
// satisfy any assertion that only counted them.

{
  const { setBuildOutputSink, trackedExec } = await import('../server/lib/build-runner.mjs')
  const seen = []
  const startedAt = Date.now()
  setBuildOutputSink((name, line) => seen.push({ at: Date.now() - startedAt, name, line }))

  await trackedExec('probe', "sh -c 'echo first; sleep 1; echo second'")
  const elapsed = Date.now() - startedAt
  setBuildOutputSink(null)

  assert.ok(seen.length >= 1, `the sink received output from a real command (saw ${seen.length})`)
  assert.ok(seen[0].at < elapsed - 300,
    `THE WIRE: output arrives WHILE the command runs, not buffered to the end `
    + `(first line at +${seen[0].at}ms of a ${elapsed}ms command)`)
  assert.equal(seen[0].name, 'probe', 'and it is labelled with the build it came from')
}

console.log('ok — a stalled build gives its slot back, a talkative slow one does not, and output really streams')
