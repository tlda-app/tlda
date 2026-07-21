import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  runDaemonStartWithSupervisedNoop,
  runBoundedDaemonStartTransition,
} from '../cli/lib/daemon-supervision-transition.mjs'
import {
  createSafeIpcSender,
} from './fleet-jsonl-ingester.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const daemonSource = readFileSync(join(here, 'fleet-daemon.mjs'), 'utf8')
const ingesterSource = readFileSync(join(here, 'fleet-jsonl-ingester.mjs'), 'utf8')
const ingestorSupervisorSource = readFileSync(join(here, '..', 'daemon', 'jsonl-ingestor.mjs'), 'utf8')
const cliSource = readFileSync(join(here, '..', 'cli', 'tlda.mjs'), 'utf8')
const transitionSource = readFileSync(join(here, '..', 'cli', 'lib', 'daemon-supervision-transition.mjs'), 'utf8')

test('JSONL ingester IPC send contains EPIPE and closed-channel failures', () => {
  const errors = []
  const processLike = {
    connected: true,
    send() {
      const e = new Error('broken pipe')
      e.code = 'EPIPE'
      throw e
    },
  }
  const send = createSafeIpcSender(processLike, { onClosed: e => errors.push(e.code) })

  assert.equal(send({ type: 'batch' }), false)
  assert.deepEqual(errors, ['EPIPE'])
  assert.equal(send({ type: 'batch' }), false)
  assert.deepEqual(errors, ['EPIPE'])
})

test('JSONL ingester IPC send rethrows unexpected failures', () => {
  const processLike = {
    connected: true,
    send() {
      const e = new Error('unexpected')
      e.code = 'EBADF'
      throw e
    },
  }
  const send = createSafeIpcSender(processLike)
  assert.throws(() => send({ type: 'batch' }), /unexpected/)
})

test('closed JSONL child IPC exits instead of remaining live and mute', () => {
  assert.match(ingesterSource, /parent IPC closed:.*exiting for resync/)
  assert.match(ingesterSource, /onClosed:[\s\S]*process\.exit\(1\)/)
})

test('JSONL child restart obligation survives a server disconnect race', () => {
  assert.match(ingestorSupervisorSource, /_jsonlIngesterRestartPending = true/)
  assert.match(ingestorSupervisorSource, /function resumeJsonlIngesterAfterServerReady\(\)/)
  assert.match(ingestorSupervisorSource, /resumeAfterServerReady: resumeJsonlIngesterAfterServerReady/)
  assert.match(daemonSource, /daemon-welcome[\s\S]*jsonlIngestor\.resumeAfterServerReady\(\)/)
})

test('fleet daemon does not intentionally exit on SIGPIPE', () => {
  assert.match(daemonSource, /process\.on\('SIGPIPE', \(\) => \{\s*log\.warn\('received SIGPIPE/)
  const exitSignalList = daemonSource.match(/for \(const sig of \[(.*?)\]\)/s)?.[1] || ''
  assert.doesNotMatch(exitSignalList, /SIGPIPE/)
})

test('bounded transition reports accepted launchd pending without fallback', async () => {
  const calls = []
  const result = await runBoundedDaemonStartTransition({
    existingPid: 111,
    log: event => calls.push(['log', event]),
    writePlist: async () => calls.push(['writePlist']),
    bootstrap: async () => calls.push(['bootstrap']),
    stopExisting: async pid => calls.push(['stopExisting', pid]),
    waitSupervised: async ({ previousPid, timeoutMs }) => {
      calls.push(['waitSupervised', previousPid, timeoutMs])
      return null
    },
    verifyTargetDaemon: async pid => calls.push(['verifyTargetDaemon', pid]),
    supervisedTimeoutMs: 25,
  })

  assert.deepEqual(result, {
    mode: 'launchd-pending',
    pid: null,
    pending: true,
    reason: 'supervised launchd did not become ready within 25ms',
  })
  assert.deepEqual(calls.map(call => call[0]), ['log', 'writePlist', 'bootstrap', 'stopExisting', 'waitSupervised'])
})

test('daemon start keeps already-supervised daemon as supervised noop', async () => {
  const result = await runDaemonStartWithSupervisedNoop({
    existingPid: 222,
    getLaunchdPid: async () => 222,
    launchdOwnsExisting: async (launchdPid, daemonPid) => launchdPid === daemonPid,
    verifyTargetDaemon: async (pid, opts) => {
      assert.equal(pid, 222)
      assert.deepEqual(opts, { supervised: true })
    },
    runBoundedTransition: async () => assert.fail('must not transition an already-supervised daemon'),
  })

  assert.deepEqual(result, { mode: 'already-supervised', pid: 222 })
})

test('bounded transition reports supervised-ready without fallback metadata', async () => {
  const result = await runBoundedDaemonStartTransition({
    existingPid: 111,
    writePlist: async () => {},
    bootstrap: async () => {},
    stopExisting: async () => {},
    waitSupervised: async () => 333,
    verifyTargetDaemon: async (pid, opts) => {
      assert.equal(pid, 333)
      assert.deepEqual(opts, { supervised: true })
    },
  })

  assert.deepEqual(result, { mode: 'supervised', pid: 333 })
})

test('bounded transition surfaces true bootstrap rejection as failure', async () => {
  await assert.rejects(
    runBoundedDaemonStartTransition({
      existingPid: 111,
      writePlist: async () => {},
      bootstrap: async () => { throw new Error('bootstrap rejected') },
      stopExisting: async () => assert.fail('must not stop existing when bootstrap rejects'),
      waitSupervised: async () => null,
      verifyTargetDaemon: async () => {},
    }),
    /bootstrap rejected/,
  )
})

test('daemon start code has no direct detached fallback or recovery script path', () => {
  assert.doesNotMatch(cliSource, /startDirectFleetDaemonFallback/)
  assert.doesNotMatch(cliSource, /fleet-daemon-recovery\.sh/)
  assert.doesNotMatch(cliSource, /direct fallback/)
  assert.doesNotMatch(transitionSource, /startDirectFallback|direct-fallback|fallbackTimeoutMs/)
})
