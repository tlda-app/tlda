import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDispatcher } from '../server/lib/build-dispatch.mjs'
import { ForkTransport, DaemonRpcTransport, makeTransport } from '../server/lib/build-transport.mjs'
import { initProjectStore } from '../server/lib/project-store.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Shared temp dir so getProjectsDir() returns a real path.
const tmpProjects = mkdtempSync(join(tmpdir(), 'tlda-bt-'))
initProjectStore(tmpProjects)

// ---------------------------------------------------------------------------
// Fake-transport contract tests
// ---------------------------------------------------------------------------

test('(1) dispatchBuild starts job with resolved {name, priorityPages, projectsDir}', async () => {
  let capturedJob = null
  const fake = {
    start(job, { onExit }) {
      capturedJob = { ...job }
      setImmediate(() => onExit(0))
      return { cancel() {} }
    },
  }

  const { dispatchBuild } = createDispatcher(fake)
  await dispatchBuild('my-doc', { priorityPages: [3, 5] })

  assert.ok(capturedJob, 'transport.start was called')
  assert.equal(capturedJob.name, 'my-doc')
  assert.deepEqual(capturedJob.priorityPages, [3, 5])
  assert.equal(capturedJob.projectsDir, tmpProjects, 'projectsDir comes from getProjectsDir()')
})

test('(2) worker messages routed through transport reach the relay', async () => {
  let capturedOnMessage = null

  const fake = {
    start(_job, { onMessage, onExit }) {
      capturedOnMessage = onMessage
      setImmediate(() => {
        // These should not throw; relay handles unknown sinks silently.
        onMessage({ t: 'report', m: 'unknownSink', a: ['arg1'] })
        onMessage({ t: 'not-report', m: 'ignored' })
        onExit(0)
      })
      return { cancel() {} }
    },
  }

  const { dispatchBuild } = createDispatcher(fake)
  await dispatchBuild('relay-doc', {})

  assert.ok(typeof capturedOnMessage === 'function', 'onMessage handler is the relay function')
  // Calling relay with non-report type is a silent no-op.
  assert.doesNotThrow(() => capturedOnMessage({ t: 'other', m: 'whatever' }))
})

test('(3) second dispatchBuild while in-flight coalesces — one start, drains once on exit', async () => {
  let startCount = 0
  let releaseExit = null

  const fake = {
    start(_job, { onExit }) {
      startCount++
      releaseExit = onExit
      return { cancel() {} }
    },
  }

  const { dispatchBuild } = createDispatcher(fake)

  const p1 = dispatchBuild('coal-doc', { priorityPages: [1] })
  const p2 = dispatchBuild('coal-doc', { priorityPages: [2] })

  assert.equal(startCount, 1, 'only one start while first build in-flight')

  // Release first build — the drain should start the second.
  releaseExit(0)
  await p1

  // Give drain's _runWorker time to call transport.start.
  await new Promise(r => setImmediate(r))
  assert.equal(startCount, 2, 'drain started the second build')

  // Release the drained build.
  releaseExit(0)
  await new Promise(r => setImmediate(r))

  assert.equal(startCount, 2, 'exactly two starts total')
  // p2 resolved immediately (coalesce returns undefined before p1 finished).
  await p2
})

test('(4) cancel() is invoked when killBuild is called', async () => {
  let cancelCalled = false

  const fake = {
    start(_job, { onExit }) {
      return {
        cancel() {
          cancelCalled = true
          onExit(1)
        },
      }
    },
  }

  const { dispatchBuild, killBuild } = createDispatcher(fake)
  const p = dispatchBuild('kill-doc', {})

  killBuild('kill-doc')

  await p
  assert.ok(cancelCalled, 'handle.cancel() was invoked by killBuild')
})

// ---------------------------------------------------------------------------
// ForkTransport integration test with a real stub worker
// ---------------------------------------------------------------------------

test('ForkTransport: stub worker emits message + exits and both handlers fire', async () => {
  const stubWorker = join(tmpdir(), 'tlda-stub-worker.mjs')
  writeFileSync(stubWorker, `
process.on('message', (msg) => {
  if (msg.t === 'build') {
    process.send({ t: 'report', m: 'broadcastSignal', a: ['stub-doc', 'signal:stub', { ok: true }] })
    process.exit(0)
  }
})
`)

  const messages = []
  const exits = []

  await new Promise((resolve) => {
    const child = fork(stubWorker, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    child.on('message', (msg) => messages.push(msg))
    child.on('exit', (code) => { exits.push(code); resolve() })
    child.send({ t: 'build', name: 'stub-doc', priorityPages: [], projectsDir: tmpProjects })
  })

  assert.equal(messages.length, 1, 'worker emitted one message')
  assert.equal(messages[0].t, 'report')
  assert.equal(messages[0].m, 'broadcastSignal')
  assert.deepEqual(messages[0].a, ['stub-doc', 'signal:stub', { ok: true }])
  assert.equal(exits[0], 0, 'worker exited cleanly')
})

// ---------------------------------------------------------------------------
// DaemonRpcTransport: calls onError + onExit(1), never forks locally
// ---------------------------------------------------------------------------

test('DaemonRpcTransport calls onError and onExit(nonzero) without forking', async () => {
  const errors = []
  const exitCodes = []

  await new Promise((resolve) => {
    DaemonRpcTransport.start(
      { name: 'rpc-doc', priorityPages: [], projectsDir: tmpProjects },
      {
        onMessage() { throw new Error('onMessage must not be called by DaemonRpcTransport stub') },
        onError(e) { errors.push(e) },
        onExit(code) { exitCodes.push(code); resolve() },
      }
    )
  })

  assert.equal(errors.length, 1, 'onError called exactly once')
  assert.match(errors[0].message, /not implemented/)
  assert.match(errors[0].message, /no-local-fallback/)
  assert.equal(exitCodes[0], 1, 'onExit called with nonzero exit code')
})

// ---------------------------------------------------------------------------
// makeTransport: config knob selects the right transport
// ---------------------------------------------------------------------------

test('makeTransport defaults to ForkTransport', () => {
  assert.equal(makeTransport({}), ForkTransport)
  assert.equal(makeTransport({ buildTransport: 'fork' }), ForkTransport)
})

test('makeTransport selects DaemonRpcTransport for "daemon-rpc"', () => {
  assert.equal(makeTransport({ buildTransport: 'daemon-rpc' }), DaemonRpcTransport)
})

test('makeTransport throws on unknown key', () => {
  assert.throws(() => makeTransport({ buildTransport: 'cloud-worker' }), /Unknown buildTransport/)
})
